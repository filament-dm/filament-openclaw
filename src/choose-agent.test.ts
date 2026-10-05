import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyPendingChoice,
  automaticChoice,
  type BindOutcome,
  choiceOptions,
  nothingFreeBody,
  handlePendingItem,
  questionBody,
  resolveChoice,
} from "./choose-agent.js";
import type { WorkItem } from "./work-item.js";

const writer = { id: "writer", name: "Writer", emoji: "✍️" };
const researcher = { id: "researcher", name: "Researcher" };

test("choiceOptions: one per agent, reserved ids out, duplicate names disambiguated", () => {
  const options = choiceOptions([
    writer,
    { ...researcher, boundAccount: "researcher" },
    { id: "default", name: "Default" },
    { id: "r2", name: "Researcher" },
  ]);
  assert.deepEqual(options, [
    { agentId: "writer", label: "✍️ Writer", taken: false },
    { agentId: "researcher", label: "Researcher (researcher)", taken: true },
    { agentId: "r2", label: "Researcher (r2)", taken: false },
  ]);
});

test("automaticChoice: only a lone free agent is chosen without asking", () => {
  assert.equal(automaticChoice(choiceOptions([writer])), "writer");
  assert.equal(automaticChoice(choiceOptions([{ ...writer, boundAccount: "writer" }])), null);
  assert.equal(automaticChoice(choiceOptions([writer, researcher])), null);
  // Taken agents do not count: one free among several is still a lone choice.
  assert.equal(
    automaticChoice(choiceOptions([writer, { ...researcher, boundAccount: "x" }])),
    "writer",
  );
  assert.equal(automaticChoice([]), null);
});

test("questionBody: one tappable suggested message per free agent; taken ones only listed", () => {
  const body = questionBody(choiceOptions([writer, { ...researcher, boundAccount: "x" }]));
  assert.match(body, /- \[✍️ Writer\]\(filament:message-send\)\n/);
  assert.doesNotMatch(body, /\[Researcher\]\(filament:message-send\)/);
  assert.match(body, /Already connected to another Filament agent: Researcher\./);
  assert.doesNotMatch(questionBody(choiceOptions([writer])), /Already connected/);
});

test("resolveChoice: a taken agent cannot be chosen", () => {
  const options = choiceOptions([writer, { ...researcher, boundAccount: "x" }]);
  assert.equal(resolveChoice("Researcher", options), null);
  assert.equal(resolveChoice("researcher", options), null);
});

test("nothingFreeBody: distinguishes no agents from all taken", () => {
  assert.match(nothingFreeBody([]), /has no agents/);
  assert.match(nothingFreeBody(choiceOptions([{ ...writer, boundAccount: "w" }])), /every agent/);
});

test("resolveChoice: the tapped label or a typed id, nothing else", () => {
  const options = choiceOptions([writer, researcher]);
  assert.equal(resolveChoice("✍️ Writer", options), "writer");
  assert.equal(resolveChoice("  RESEARCHER ", options), "researcher");
  assert.equal(resolveChoice("writ", options), null);
  assert.equal(resolveChoice("", options), null);
});

test("applyPendingChoice: binds the agent under its own account and drops the pending one", () => {
  const draft: Record<string, unknown> = {
    plugins: {
      entries: {
        "filament-openclaw": {
          config: { accounts: { "pending-abc": { connectToken: "fmcp_x", pending: true } } },
        },
      },
    },
    bindings: [],
  };
  assert.equal(applyPendingChoice(draft, "pending-abc", "writer", "fmcp_x"), true);
  const plugins = draft.plugins as { entries: Record<string, { config: { accounts: unknown } }> };
  assert.deepEqual(plugins.entries["filament-openclaw"]!.config.accounts, {
    writer: { connectToken: "fmcp_x" },
  });
  assert.deepEqual(draft.bindings, [
    { agentId: "writer", match: { channel: "filament", accountId: "writer" } },
  ]);
});

function item(body: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    channel_id: "!cc",
    thread_id: null,
    is_backchannel: true,
    messages: [{ event_id: "$1", sender: "@owner:x", body, ts: 1 }],
    ...overrides,
  } as WorkItem;
}

function harness(
  answer: string,
  overrides: Partial<WorkItem> = {},
  bindResult: BindOutcome = "applied",
) {
  const said: string[] = [];
  const bound: string[] = [];
  const consumed: string[] = [];
  const run = handlePendingItem({
    item: item(answer, overrides),
    principal: "@owner:x",
    ccRoomId: "!cc",
    options: choiceOptions([writer, researcher]),
    consume: async (id) => {
      consumed.push(id);
    },
    say: async (body) => {
      said.push(body);
    },
    bind: async (id) => {
      bound.push(id);
      return bindResult;
    },
    log: () => {},
  });
  return { run, said, bound, consumed };
}

test("handlePendingItem: a tap binds that agent; once applied, the bound agent does the talking", async () => {
  const h = harness("✍️ Writer");
  assert.deepEqual(await h.run, { kind: "silent" });
  assert.deepEqual(h.consumed, ["$1"]);
  assert.deepEqual(h.bound, ["writer"]);
  assert.deepEqual(h.said, []);
});

test("handlePendingItem: a bind the gateway did not pick up says how to finish it", async () => {
  const h = harness("✍️ Writer", {}, "written");
  assert.deepEqual(await h.run, { kind: "silent" });
  assert.deepEqual(h.bound, ["writer"]);
  assert.equal(h.said.length, 1);
  assert.match(h.said[0]!, /saved \*\*✍️ Writer\*\*/);
  assert.match(h.said[0]!, /openclaw gateway restart/);
});

test("handlePendingItem: a bind cut short by the reload says nothing", async () => {
  const said: string[] = [];
  const run = handlePendingItem({
    item: item("✍️ Writer"),
    principal: "@owner:x",
    ccRoomId: "!cc",
    options: choiceOptions([writer, researcher]),
    consume: async () => {},
    say: async (body) => {
      said.push(body);
    },
    bind: async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    },
    log: () => {},
  });
  assert.deepEqual(await run, { kind: "silent" });
  assert.deepEqual(said, []);
});

test("handlePendingItem: an agent taken before the write is reported and the question re-asked", async () => {
  const h = harness("✍️ Writer", {}, "taken");
  assert.deepEqual(await h.run, { kind: "silent" });
  assert.deepEqual(h.bound, ["writer"]);
  assert.equal(h.said.length, 1);
  assert.match(h.said[0]!, /Writer\*\* was just connected to another Filament agent/);
  assert.match(h.said[0]!, /Tap the OpenClaw agent/);
  assert.doesNotMatch(h.said[0]!, /answers here from now on/);
});

test("handlePendingItem: anything else asks again and binds nothing", async () => {
  const h = harness("hello?");
  await h.run;
  assert.deepEqual(h.bound, []);
  assert.match(h.said[0]!, /didn't catch that/);
});

test("handlePendingItem: work outside the principal's backchannel is consumed and ignored", async () => {
  const h = harness("✍️ Writer", { is_backchannel: false, channel_id: "!other" });
  await h.run;
  assert.deepEqual(h.consumed, ["$1"]);
  assert.deepEqual(h.bound, []);
  assert.deepEqual(h.said, []);
});

test("applyPendingChoice: an agent bound to another live account meanwhile is refused, nothing changes", () => {
  const draft: Record<string, unknown> = {
    plugins: {
      entries: {
        "filament-openclaw": {
          config: {
            accounts: {
              writer: { connectToken: "fmcp_first" },
              "pending-abc": { connectToken: "fmcp_x", pending: true },
            },
          },
        },
      },
    },
    bindings: [{ agentId: "writer", match: { channel: "filament", accountId: "writer" } }],
  };
  const before = JSON.stringify(draft);
  assert.equal(applyPendingChoice(draft, "pending-abc", "writer", "fmcp_x"), false);
  assert.equal(JSON.stringify(draft), before);
  // The same token re-applied (a retried write) is not a conflict.
  assert.equal(applyPendingChoice(draft, "pending-abc", "writer", "fmcp_first"), true);
});
