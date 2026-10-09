import assert from "node:assert/strict";
import { test } from "node:test";

import type { FilamentMcpClient, ToolCallResult } from "../../mcp-client.js";
import type { McpSettings } from "../../settings.js";
import type { WorkItem } from "../../work-item.js";
import type { TransportContext, TurnResult } from "../types.js";
import type { FcmMessageEnvelope, FcmReceiverOptions } from "./receiver.js";
import { runFcmTransport } from "./index.js";

const SELF = "@a_test1.1:example.test";
const PRINCIPAL = "@u_test1:example.test";
const CC = "!cc:example.test";
const ROOM = "!general:example.test";

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
          branch: { type: "channel_message", sender_id: "@u_test2:example.test", ...branch },
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
    registerThrows?: boolean;
    holdTurns?: Promise<void>;
    commands?: boolean;
  } = {},
) {
  const { client, calls, pongs } = fakeClient({ instructions: overrides.instructions });
  if (overrides.registerThrows) {
    const callTool = client.callTool;
    client.callTool = async (name, args) => {
      if (name === "register_push_token") throw new TypeError("fetch failed");
      return callTool(name, args);
    };
  }
  const receiverStops: number[] = [];
  const controller = new AbortController();
  const turns: WorkItem[] = [];
  const controlItems: WorkItem[] = [];
  const commandItems: WorkItem[] = [];
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
      await overrides.holdTurns;
      return {
        finalText: "the reply",
        mediaUrls: [],
        agentId: "writer",
        mediaLocalRoots: [],
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
    ...(overrides.commands
      ? {
          handleCommand: async (item: WorkItem) => {
            commandItems.push(item);
          },
        }
      : {}),
  };
  const done = runFcmTransport(ctx, {
    createReceiver: (opts: FcmReceiverOptions) => ({
      start: async () => {
        if (overrides.startFails) throw new Error("PHONE_REGISTRATION_ERROR");
        deliver = opts.onMessage;
      },
      token: () => "fcm-token",
      stop: () => {
        receiverStops.push(1);
      },
    }),
  });
  const push = async (env: FcmMessageEnvelope) => {
    await until(() => deliver !== null && calls.some((c) => c.name === "register_push_token"));
    deliver!(env);
  };
  return {
    ctx,
    calls,
    pongs,
    turns,
    controlItems,
    commandItems,
    push,
    done,
    receiverStops,
    stop: () => controller.abort(),
  };
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

test("fcm: a turn shows a reading status where the reply goes, and clears it after", async () => {
  const h = harness();
  await h.push(chat({ event_id: "$m1", content: { text: "hi" }, is_mention_of_recipient: true }));
  await until(() => h.calls.some((c) => c.name === "reply_in_thread"));
  const names = h.calls.map((c) => c.name).filter((n) => n !== "register_push_token");
  assert.deepEqual(names.slice(-3), ["set_status", "set_status", "reply_in_thread"]);
  const [open, clear] = h.calls.filter((c) => c.name === "set_status");
  assert.deepEqual(open!.args, {
    channel: ROOM,
    thread_id: "$m1",
    status_text: "reading a new message",
    about_message_id: "$m1",
    timeout_ms: 60_000,
  });
  assert.deepEqual(clear!.args, { channel: ROOM, thread_id: "$m1" });
  h.stop();
});

test("fcm: the backchannel status is on the main timeline", async () => {
  const h = harness();
  await h.push(chat({ event_id: "$b1", sender_id: PRINCIPAL, content: { text: "status?" } }, CC));
  await until(() => h.calls.some((c) => c.name === "message_principal"));
  const open = h.calls.find((c) => c.name === "set_status")!;
  assert.equal(open.args.channel, CC);
  assert.equal(open.args.thread_id, null);
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

test("fcm: a /filament command from the principal goes to handleCommand, never to a turn", async () => {
  const h = harness({ commands: true });
  await h.push(
    chat({ event_id: "$u1", sender_id: PRINCIPAL, content: { text: "/filament update" } }, CC),
  );
  await until(() => h.commandItems.length === 1);
  assert.equal(h.commandItems[0]!.channel_id, CC);
  assert.equal(h.commandItems[0]!.messages[0]!.body, "/filament update");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.turns.length, 0);
  assert.equal(
    h.calls.filter((c) => c.name !== "register_push_token").length,
    0,
    "a command makes no reply or status call of its own",
  );
  h.stop();
});

test("fcm: a command waits its turn behind a running turn", async () => {
  let release!: () => void;
  const holdTurns = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({ commands: true, holdTurns });
  await h.push(chat({ event_id: "$m1", content: { text: "hi" }, is_mention_of_recipient: true }));
  await until(() => h.turns.length === 1);
  await h.push(
    chat({ event_id: "$u1", sender_id: PRINCIPAL, content: { text: "/filament update" } }, CC),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.commandItems.length, 0);
  release();
  await until(() => h.commandItems.length === 1);
  assert.equal(h.turns.length, 1);
  h.stop();
});

test("fcm: a receiver that cannot register is fatal", async () => {
  const h = harness({ startFails: true });
  const result = await h.done;
  assert.match(result.fatal ?? "", /PHONE_REGISTRATION_ERROR/);
});

test("fcm: a register call that throws stops the receiver and is fatal", async () => {
  const h = harness({ registerThrows: true });
  const result = await h.done;
  assert.match(result.fatal ?? "", /register_push_token threw/);
  assert.equal(h.receiverStops.length, 1);
});

function held() {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { hold, release };
}

const mention = (n: number) =>
  chat({ event_id: `$m${n}`, content: { text: "hi" }, is_mention_of_recipient: true });

test("fcm: a ping is answered while a turn is still running", async () => {
  const { hold, release } = held();
  const h = harness({ holdTurns: hold });
  await h.push(mention(1));
  await until(() => h.turns.length === 1);
  await h.push({
    persistentId: "ping",
    message: { data: { body: JSON.stringify({ type: "io.filament.ping", nonce: "n1" }) } },
  } as FcmMessageEnvelope);
  await until(() => h.pongs.includes("n1"));
  assert.equal(h.turns.length, 1);
  release();
  h.stop();
});

test("fcm: turns beyond the waiting limit are dropped", async () => {
  const { hold, release } = held();
  const h = harness({ holdTurns: hold });
  for (let n = 1; n <= 25; n++) await h.push(mention(n));
  release();
  await until(() => h.turns.length === 20);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.turns.length, 20);
  h.stop();
});
