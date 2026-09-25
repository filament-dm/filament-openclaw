import assert from "node:assert/strict";
import { test } from "node:test";

import type { FilamentMcpClient, ToolCallResult } from "../../mcp-client.js";
import type { McpSettings } from "../../settings.js";
import type { WorkItem } from "../../work-item.js";
import type { TransportContext, TurnResult } from "../types.js";
import type { FcmMessageEnvelope, FcmReceiverOptions } from "./receiver.js";
import { runFcmTransport } from "./index.js";

const SELF = "@a_test1.1:filament-dev.local";
const PRINCIPAL = "@u_test1:filament-dev.local";
const CC = "!cc:filament-dev.local";
const ROOM = "!general:filament-dev.local";

type Call = { name: string; args: Record<string, unknown> };

function fakeClient(opts: { instructions?: string } = {}) {
  const calls: Call[] = [];
  const pongs: string[] = [];
  const ok = (data: unknown): ToolCallResult => ({ ok: true, httpStatus: 200, data });
  const client = {
    instructions: opts.instructions ?? null,
    callTool: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      return ok({ event_id: `$reply${calls.length}` });
    },
    listPendingInvites: async () => ok({ invites: [] }),
    listVouches: async () => ok({ vouches: [] }),
    acceptInvite: async (id: string) => {
      calls.push({ name: "accept_invite", args: { loop_id: id } });
      return ok({});
    },
    acceptVouch: async (id: string) => {
      calls.push({ name: "accept_vouch", args: { loop_id: id } });
      return ok({});
    },
    pong: async (nonce: string) => {
      pongs.push(nonce);
      return 200;
    },
  };
  return { client: client as unknown as FilamentMcpClient, calls, pongs };
}

function chat(branch: Record<string, unknown>, roomId = ROOM, pid = String(Math.random())) {
  return {
    persistentId: pid,
    message: {
      data: {
        body: JSON.stringify({
          event_id: branch.event_id ?? "$e1",
          room_id: roomId,
          branch: { type: "channel_message", sender_id: "@u_test2:filament-dev.local", ...branch },
        }),
      },
    },
  } satisfies FcmMessageEnvelope;
}

async function until(check: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function harness(
  overrides: {
    control?: boolean;
    turn?: Partial<TurnResult>;
    instructions?: string;
    startFails?: boolean;
  } = {},
) {
  const { client, calls, pongs } = fakeClient({ instructions: overrides.instructions });
  const controller = new AbortController();
  const turns: WorkItem[] = [];
  const controlItems: WorkItem[] = [];
  let deliver: ((env: FcmMessageEnvelope) => void) | null = null;
  const ctx: TransportContext = {
    accountId: "writer",
    client,
    identity: { mxid: SELF, principal: PRINCIPAL, ccRoomId: CC },
    settings: { firebase: { projectId: "p" } } as unknown as McpSettings,
    control: overrides.control ?? false,
    abortSignal: controller.signal,
    log: () => {},
    runTurn: async (item) => {
      turns.push(item);
      return {
        finalText: "the reply",
        sawFinal: true,
        sawSkip: false,
        sawError: false,
        repliedTo: new Set(),
        ...overrides.turn,
      };
    },
    handleControl: async (item) => {
      controlItems.push(item);
    },
  };
  const done = runFcmTransport(ctx, {
    createReceiver: (opts: FcmReceiverOptions) => ({
      start: async () => {
        if (overrides.startFails) throw new Error("PHONE_REGISTRATION_ERROR");
        deliver = opts.onMessage;
      },
      token: () => "fcm-token",
      stop: () => {},
    }),
  });
  const push = async (env: FcmMessageEnvelope) => {
    await until(() => deliver !== null && calls.some((c) => c.name === "register_push_token"));
    deliver!(env);
  };
  return { ctx, calls, pongs, turns, controlItems, push, done, stop: () => controller.abort() };
}

test("fcm: registers the receiver's token, then greets on first contact", async () => {
  const h = harness({ instructions: "First contact: say hello" });
  await until(() => h.calls.some((c) => c.name === "message_principal"));
  assert.deepEqual(h.calls[0], {
    name: "register_push_token",
    args: { token: "fcm-token", platform: "android" },
  });
  h.stop();
  assert.deepEqual(await h.done, {});
});

test("fcm: a mention in a channel runs one turn and threads the reply off it", async () => {
  const h = harness();
  await h.push(chat({ event_id: "$m1", content: { text: "hi" }, is_mention_of_recipient: true }));
  await until(() => h.calls.some((c) => c.name === "reply_in_thread"));
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0]!.channel_id, ROOM);
  assert.equal(h.turns[0]!.messages[0]!.body, "hi");
  assert.deepEqual(h.calls.at(-1), {
    name: "reply_in_thread",
    args: { message_id: "$m1", markdown_body: "the reply" },
  });
  h.stop();
});

test("fcm: an unaddressed channel message wakes nothing", async () => {
  const h = harness();
  await h.push(chat({ event_id: "$quiet", content: { text: "just chatting" } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.turns.length, 0);
  h.stop();
});

test("fcm: the backchannel answers the principal", async () => {
  const h = harness();
  await h.push(chat({ event_id: "$b1", sender_id: PRINCIPAL, content: { text: "status?" } }, CC));
  await until(() => h.calls.some((c) => c.name === "message_principal"));
  assert.equal(h.turns[0]!.is_backchannel, true);
  h.stop();
});

test("fcm: a reply a tool already sent is not posted again", async () => {
  const h = harness({ turn: { repliedTo: new Set(["*"]) } });
  await h.push(chat({ event_id: "$m2", content: { text: "hi" }, is_mention_of_recipient: true }));
  await until(() => h.turns.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    h.calls.some((c) => c.name === "reply_in_thread"),
    false,
  );
  h.stop();
});

test("fcm: the same event pushed twice runs one turn", async () => {
  const h = harness();
  const env = chat({ event_id: "$dup", content: { text: "hi" }, is_mention_of_recipient: true });
  await h.push(env);
  await h.push({ ...env, persistentId: "another-pid" });
  await until(() => h.calls.some((c) => c.name === "reply_in_thread"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.turns.length, 1);
  h.stop();
});

test("fcm: a liveness ping is answered without a turn", async () => {
  const h = harness();
  await h.push({
    persistentId: "ping",
    message: { data: { body: JSON.stringify({ type: "io.filament.ping", nonce: "n1" }) } },
  });
  await until(() => h.pongs.length === 1);
  assert.equal(h.pongs[0], "n1");
  assert.equal(h.turns.length, 0);
  h.stop();
});

test("fcm: a control account hands backchannel pushes to the gateway, never to a turn", async () => {
  const h = harness({ control: true });
  await h.push(
    chat({ event_id: "$c1", sender_id: PRINCIPAL, content: { text: "/filament agents" } }, CC),
  );
  await until(() => h.controlItems.length === 1);
  await h.push(chat({ event_id: "$c2", content: { text: "hi" }, is_mention_of_recipient: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.controlItems.length, 1);
  assert.equal(h.turns.length, 0);
  h.stop();
});

test("fcm: a receiver that cannot register is fatal", async () => {
  const h = harness({ startFails: true });
  const result = await h.done;
  assert.match(result.fatal ?? "", /PHONE_REGISTRATION_ERROR/);
});
