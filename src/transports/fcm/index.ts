/**
 * The FCM transport — the default, and what production Filament speaks.
 *
 * Needs nothing beyond develop's agents API: no poll_work, no reply_with, no
 * work ledger, no token exchange. The sequence follows the original FCM
 * plugin (`main`, Jonathan Strickland), per account:
 *
 *   accept pending invites/vouches → register with FCM (./receiver.ts) →
 *   register_push_token → first-contact greeting → hold the socket open
 *
 * and each push:
 *
 *   decode (./decode.ts) →
 *     ping           → POST /pong (no model)
 *     invite / vouch → accept it
 *     chat message   → control account: gateway command (src/gateway.ts)
 *                      otherwise: wake? (./wake-policy.ts) → one agent turn →
 *                      reply once where participation allows (./reply-route.ts)
 *
 * Turns run one at a time per account, in arrival order. A failed turn is
 * logged and dropped: without a ledger there is nothing to redeliver it, and
 * pausing the account would drop everything after it too.
 */
import type { FilamentMcpClient } from "../../mcp-client.js";
import { isFirstContact } from "../../onboarding-core.js";
import type { WorkItem } from "../../work-item.js";
import type { TransportContext, TransportResult } from "../types.js";
import {
  type DecodedPush,
  decodeDirectPusher,
  isChatMessage,
  isInvite,
  isVouch,
} from "./decode.js";
import { FcmReceiver, type FcmReceiverOptions } from "./receiver.js";
import { alreadyAnswered, type RoutablePush, routeReply } from "./reply-route.js";
import { decideWake, EngagedThreads } from "./wake-policy.js";

/** What Filament stores the token as: DirectPusher's FCM (not APNs) kind. */
const PUSH_PLATFORM = "android";
const MAX_SEEN_EVENTS = 500;

/** Extract the `loop_id`s from a list_pending_invites / list_vouches result. */
function loopIds(data: unknown, key: "invites" | "vouches"): string[] {
  if (!data || typeof data !== "object") return [];
  const list = (data as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return list
    .map((item) =>
      item && typeof item === "object" ? (item as { loop_id?: unknown }).loop_id : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Accept what the agent was invited or vouched into while offline. Never throws. */
async function acceptPending(
  client: FilamentMcpClient,
  log: (message: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const sweep = async (
    kind: "invites" | "vouches",
    list: () => ReturnType<FilamentMcpClient["listVouches"]>,
    accept: (loopId: string) => ReturnType<FilamentMcpClient["acceptVouch"]>,
  ) => {
    try {
      const res = await list();
      for (const loopId of res.ok ? loopIds(res.data, kind) : []) {
        const accepted = await accept(loopId);
        log(
          `filament-fcm: accept ${kind === "invites" ? "invite" : "vouch"} ${loopId} ${accepted.ok ? "ok" : `failed (${accepted.error?.code ?? "?"})`}`,
        );
      }
    } catch (error) {
      log(`filament-fcm: pending ${kind} sweep failed (continuing): ${String(error)}`);
    }
  };
  await sweep(
    "invites",
    () => client.listPendingInvites({ signal }),
    (id) => client.acceptInvite(id, { signal }),
  );
  await sweep(
    "vouches",
    () => client.listVouches({ signal }),
    (id) => client.acceptVouch(id, { signal }),
  );
}

/** One-line summary of a decoded push for observability (never the whole text). */
function summarize(push: DecodedPush): string {
  const parts = [`type=${push.branchType}`];
  if (push.roomId) parts.push(`room=${push.roomId}`);
  if (push.senderId) parts.push(`from=${push.senderId}`);
  if (push.eventId) parts.push(`event=${push.eventId}`);
  if (push.threadId) parts.push(`thread=${push.threadId}`);
  return parts.join(" ");
}

/** The body the agent sees for a push; a media-only message still says what it is. */
function messageBody(push: DecodedPush): string {
  if (typeof push.text === "string" && push.text) return push.text;
  return push.hasMedia || push.text === null ? "(an attachment, with no text)" : "";
}

/** The receiver surface the transport uses; a fake stands in for it in tests. */
export interface PushSource {
  start(): Promise<void>;
  token(): string | null;
  stop(): void;
}

export interface FcmTransportDeps {
  createReceiver?: (opts: FcmReceiverOptions) => PushSource;
}

export async function runFcmTransport(
  ctx: TransportContext,
  deps: FcmTransportDeps = {},
): Promise<TransportResult> {
  const { client, identity, accountId, abortSignal, log, settings } = ctx;
  const engaged = new EngagedThreads();
  const seenEvents = new Set<string>();

  // Turns run strictly one after another, in arrival order.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work).catch((error) => {
      log(`filament-fcm: push handling threw (continuing): ${String(error)}`);
    });
  };

  const firstSighting = (eventId: string): boolean => {
    if (seenEvents.has(eventId)) return false;
    seenEvents.add(eventId);
    if (seenEvents.size > MAX_SEEN_EVENTS) {
      const oldest = seenEvents.values().next().value;
      if (oldest !== undefined) seenEvents.delete(oldest);
    }
    return true;
  };

  const handleChat = async (push: DecodedPush, roomId: string, eventId: string) => {
    const isBackchannel = !!identity.ccRoomId && roomId === identity.ccRoomId;
    const item: WorkItem = {
      channel_id: roomId,
      thread_id: push.threadId ?? null,
      is_backchannel: isBackchannel,
      is_direct: push.branchType === "direct_message",
      messages: [
        {
          event_id: eventId,
          sender: push.senderId ?? "unknown",
          body: messageBody(push),
          ts: Date.now(),
        },
      ],
    };

    if (ctx.control) {
      // The gateway only takes commands; the authority check lives there.
      if (isBackchannel) await ctx.handleControl(item);
      return;
    }

    const decision = decideWake(push, {
      selfMxid: identity.mxid,
      ccRoomId: identity.ccRoomId,
      engaged,
    });
    if (!decision.wake) {
      log(`filament-fcm: not waking for ${eventId} in ${roomId} (${decision.reason})`);
      return;
    }
    if (!isBackchannel && push.branchType === "channel_message") {
      engaged.record(roomId, push.threadId ?? eventId);
    }
    log(`filament-fcm: waking for ${eventId} in ${roomId} (${decision.reason})`);

    let result;
    try {
      result = await ctx.runTurn(item);
    } catch (error) {
      log(`filament-fcm: turn for ${eventId} threw; dropping it: ${String(error)}`);
      return;
    }
    if (result.sawError) {
      log(`filament-fcm: turn for ${eventId} failed; dropping it: ${result.errorDetail ?? "?"}`);
      return;
    }
    if (!result.sawFinal) {
      log(`filament-fcm: turn for ${eventId} produced no reply`);
      return;
    }

    const routable: RoutablePush = {
      roomId,
      eventId,
      threadId: push.threadId ?? null,
      isBackchannel,
      isDirect: push.branchType === "direct_message",
    };
    if (alreadyAnswered(routable, result.repliedTo)) {
      log(`filament-fcm: a tool already replied to ${eventId}; not posting the final text`);
      return;
    }
    if (abortSignal.aborted) return;
    const route = routeReply(routable);
    const res = await client.callTool(
      route.tool,
      { ...route.args, markdown_body: result.finalText },
      { signal: abortSignal },
    );
    const data = res.data as Record<string, unknown> | undefined;
    if (res.ok && typeof data?.event_id === "string" && data.error === undefined) {
      log(`filament-fcm: reply posted to ${roomId} via ${route.tool}`);
    } else {
      const why =
        res.error?.message ?? (typeof data?.error === "string" ? data.error : "no event_id");
      log(`filament-fcm: reply to ${eventId} via ${route.tool} failed: ${why}`);
    }
  };

  const handlePush = async (push: DecodedPush) => {
    if (push.branchType === "io.filament.ping") {
      if (!push.nonce) return;
      const status = await client.pong(push.nonce, { signal: abortSignal });
      log(`filament-fcm: pong sent (HTTP ${status})`);
      return;
    }
    if (isInvite(push.branchType) || isVouch(push.branchType)) {
      if (ctx.control) return;
      // An invite carries the room/space in room_id; a vouch's loop is on the branch.
      const targetId = isVouch(push.branchType) ? (push.loopId ?? push.roomId) : push.roomId;
      if (!targetId) return;
      const res = isVouch(push.branchType)
        ? await client.acceptVouch(targetId, { signal: abortSignal })
        : await client.acceptInvite(targetId, { signal: abortSignal });
      log(
        `filament-fcm: ${push.branchType} ${targetId} ${res.ok ? "accepted" : `accept failed (${res.error?.code ?? "?"})`}`,
      );
      return;
    }
    if (!isChatMessage(push.branchType) || !push.roomId || !push.eventId) {
      log(`filament-fcm: ${push.branchType} not handled`);
      return;
    }
    if (!firstSighting(push.eventId)) {
      log(`filament-fcm: event ${push.eventId} already handled; skipping`);
      return;
    }
    await handleChat(push, push.roomId, push.eventId);
  };

  if (!ctx.control) await acceptPending(client, log, abortSignal);

  const createReceiver =
    deps.createReceiver ?? ((opts: FcmReceiverOptions): PushSource => new FcmReceiver(opts));
  const receiver = createReceiver({
    accountId,
    firebase: settings.firebase,
    log,
    abortSignal,
    onMessage: (env) => {
      const push = decodeDirectPusher(env);
      if (!push) {
        log(`filament-fcm: push ${env.persistentId || "(no id)"} is badge-only or unreadable`);
        return;
      }
      log(`filament-fcm: inbound ${summarize(push)}`);
      enqueue(() => handlePush(push));
    },
  });
  try {
    await receiver.start();
  } catch (error) {
    receiver.stop();
    if (abortSignal.aborted) return {};
    return { fatal: `fcm: ${String(error)}` };
  }

  const token = receiver.token();
  if (!token) {
    receiver.stop();
    return { fatal: "fcm: registered, but no push token to hand Filament" };
  }
  const registered = await client.callTool(
    "register_push_token",
    { token, platform: PUSH_PLATFORM },
    { signal: abortSignal },
  );
  if (!registered.ok) {
    receiver.stop();
    if (abortSignal.aborted) return {};
    return {
      fatal: `fcm: register_push_token failed (${registered.kind ?? "?"}: ${registered.error?.message ?? "?"})`,
    };
  }
  log(`filament-fcm: push token registered with Filament (project ${settings.firebase.projectId})`);

  if (!ctx.control && isFirstContact(client.instructions)) {
    const hello = await client.callTool(
      "message_principal",
      { markdown_body: "Hi — I'm connected to Filament and ready." },
      { signal: abortSignal },
    );
    log(hello.ok ? "filament-fcm: sent first-contact hello" : "filament-fcm: greeting failed");
  }

  await new Promise<void>((resolve) => {
    if (abortSignal.aborted) return resolve();
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
  receiver.stop();
  return {};
}
