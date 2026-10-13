import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolCallResult } from "./mcp-client.js";
import {
  isDefaultAgentName,
  parseIdentityMarkdown,
  seedName,
  seedProfile,
  type AvatarSource,
  type SeedClient,
} from "./profile-seed.js";

test("isDefaultAgentName: the server's '<Owner>'s agent [n]' and 'My agent [n]', nothing else", () => {
  assert.equal(isDefaultAgentName("Test One's agent", "Test One"), true);
  assert.equal(isDefaultAgentName("Test One's agent 2", "Test One"), true);
  assert.equal(isDefaultAgentName("  test one's   AGENT 12 ", "Test One"), true);
  assert.equal(isDefaultAgentName("My agent 3", undefined), true);
  assert.equal(isDefaultAgentName("", "Test One"), true);
  assert.equal(isDefaultAgentName(undefined, "Test One"), true);
  assert.equal(isDefaultAgentName("Carl", "Test One"), false);
  assert.equal(isDefaultAgentName("Test One's agent of chaos", "Test One"), false);
  assert.equal(isDefaultAgentName("Someone Else's agent", "Test One"), false);
  // Regex characters in an owner's name are literal.
  assert.equal(isDefaultAgentName("A.B (x)'s agent 2", "A.B (x)"), true);
  assert.equal(isDefaultAgentName("AxB (x)'s agent 2", "A.B (x)"), false);
});

test("parseIdentityMarkdown: `- Label: value` lines, skipping the template's hints", () => {
  assert.deepEqual(
    parseIdentityMarkdown(
      "# IDENTITY.md\n\n- **Name:** Carl\n- **Emoji:** 🦝\n- Creature: raccoon\n- Name: Later\n",
    ),
    { name: "Carl", emoji: "🦝" },
  );
  // The stock template: labels with the hint on the next line, or in parentheses.
  assert.deepEqual(
    parseIdentityMarkdown("- **Name:**\n  _(pick something you like)_\n- Emoji: (your signature)"),
    {},
  );
});

test("seedName: identity name, IDENTITY.md, entry name, then the id — never a bare 'main'", () => {
  const cfg = (entry: Record<string, unknown>, id = "main") => ({
    agents: { entries: { [id]: entry } },
  });
  assert.equal(seedName(cfg({ identity: { name: "Carl" }, name: "x" }), "main"), "Carl");
  assert.equal(
    seedName(cfg({ identity: { name: "main" }, name: "main" }), "main", { name: "Carl" }),
    "Carl",
  );
  assert.equal(seedName(cfg({ name: "Newsie" }, "news"), "news"), "Newsie");
  // A fresh onboarded config names nothing but the id.
  assert.equal(seedName(cfg({ name: "main", identity: { name: "main" } }), "main"), undefined);
  assert.equal(seedName(cfg({ name: "newshound" }, "newshound"), "newshound"), "newshound");
  assert.equal(seedName({}, "main"), undefined);
});

function fakeClient(self: Record<string, unknown> | null, opts: { setFails?: boolean } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const uploads: Array<{ bytes: Uint8Array; contentType: string; filename?: string }> = [];
  const ok = (data: unknown): ToolCallResult => ({ ok: true, data }) as ToolCallResult;
  const client: SeedClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "get_self") {
        return self ? ok(self) : ({ ok: false, error: { message: "down" } } as ToolCallResult);
      }
      if (opts.setFails) return { ok: false, error: { message: "nope" } } as ToolCallResult;
      return ok({});
    },
    uploadMedia: async (bytes, contentType, filename) => {
      uploads.push({ bytes, contentType, filename });
      return "mxc://example.test/avatar";
    },
  };
  return { client, calls, uploads };
}

const DEFAULT_SELF = {
  display_name: "Test One's agent 2",
  avatar_url: null,
  owner: { user_id: "@one:x", display_name: "Test One" },
};

async function seed(
  self: Record<string, unknown> | null,
  name: string | undefined,
  avatar: AvatarSource,
  opts: { setFails?: boolean } = {},
) {
  const fake = fakeClient(self, opts);
  const logs: string[] = [];
  const result = await seedProfile({
    client: fake.client,
    name,
    avatar,
    readFile: async (path) => new TextEncoder().encode(`bytes of ${path}`),
    log: (line) => void logs.push(line),
  });
  return { result, logs, ...fake };
}

test("seedProfile: a default-named agent takes the OpenClaw name and a local avatar, uploaded", async () => {
  const run = await seed(DEFAULT_SELF, "Carl", { kind: "local", filePath: "/ws/avatars/carl.PNG" });
  assert.deepEqual(run.result, { name: "Carl", image: true });
  assert.deepEqual(run.uploads, [
    {
      bytes: new TextEncoder().encode("bytes of /ws/avatars/carl.PNG"),
      contentType: "image/png",
      filename: "carl.PNG",
    },
  ]);
  assert.deepEqual(run.calls.at(-1), {
    name: "set_profile",
    args: { name: "Carl", image: "mxc://example.test/avatar" },
  });
});

test("seedProfile: a remote avatar is passed for the server to fetch; a data URI is uploaded", async () => {
  const remote = await seed(DEFAULT_SELF, undefined, { kind: "remote", url: "https://x/a.png" });
  assert.deepEqual(remote.calls.at(-1)!.args, { image: "https://x/a.png" });
  assert.equal(remote.uploads.length, 0);

  const data = await seed(DEFAULT_SELF, "Carl", {
    kind: "data",
    url: "data:image/gif;base64,R0lG",
  });
  assert.equal(data.uploads[0]!.contentType, "image/gif");
  assert.deepEqual([...data.uploads[0]!.bytes], [...Buffer.from("R0lG", "base64")]);
  // Not an image: no upload, the name still goes.
  const text = await seed(DEFAULT_SELF, "Carl", { kind: "data", url: "data:text/plain,hi" });
  assert.deepEqual(text.calls.at(-1)!.args, { name: "Carl" });
});

test("seedProfile: a name the owner chose, or an existing picture, is never replaced", async () => {
  const named = await seed({ ...DEFAULT_SELF, display_name: "Raccoon" }, "Carl", {
    kind: "remote",
    url: "https://x/a.png",
  });
  assert.equal(named.result, null);
  assert.deepEqual(
    named.calls.map((c) => c.name),
    ["get_self"],
  );

  const pictured = await seed({ ...DEFAULT_SELF, avatar_url: "mxc://x/owner-pick" }, "Carl", {
    kind: "remote",
    url: "https://x/a.png",
  });
  assert.deepEqual(pictured.calls.at(-1)!.args, { name: "Carl" });
  assert.deepEqual(pictured.result, { name: "Carl", image: false });
});

test("seedProfile: nothing to give, or a failure anywhere, leaves the profile and never throws", async () => {
  const nothing = await seed(DEFAULT_SELF, undefined, { kind: "none" });
  assert.equal(nothing.result, null);
  assert.deepEqual(
    nothing.calls.map((c) => c.name),
    ["get_self"],
  );

  const down = await seed(null, "Carl", { kind: "none" });
  assert.equal(down.result, null);
  assert.match(down.logs[0]!, /get_self failed/);

  const refused = await seed(DEFAULT_SELF, "Carl", { kind: "none" }, { setFails: true });
  assert.equal(refused.result, null);
  assert.match(refused.logs.at(-1)!, /set_profile failed/);

  // An avatar file of a kind Filament would not show is skipped; the name still goes.
  const odd = await seed(DEFAULT_SELF, "Carl", { kind: "local", filePath: "/ws/a.bmp" });
  assert.equal(odd.uploads.length, 0);
  assert.deepEqual(odd.result, { name: "Carl", image: false });
});
