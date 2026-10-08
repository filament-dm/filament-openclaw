import { acceptPending } from "../../accept-pending.js";
import { isFirstContact } from "../../onboarding-core.js";
import { isGatewayCommandItem } from "../../gateway.js";
import { ATTACHMENT_ONLY_BODY } from "../../work-item.js";
import {
  decodeDirectPusher,
  isChatMessage,
  isInvite,
  isVouch
} from "./decode.js";
import { FcmReceiver } from "./receiver.js";
import { alreadyAnswered, routeReply } from "./reply-route.js";
import { decideWake, EngagedThreads } from "./wake-policy.js";
const PUSH_PLATFORM = "android";
const MAX_SEEN_EVENTS = 500;
const MAX_PENDING_TURNS = 20;
const OPENING_STATUS = "reading a new message";
const STATUS_TIMEOUT_MS = 6e4;
function summarize(push) {
  const parts = [`type=${push.branchType}`];
  if (push.roomId) parts.push(`room=${push.roomId}`);
  if (push.senderId) parts.push(`from=${push.senderId}`);
  if (push.eventId) parts.push(`event=${push.eventId}`);
  if (push.threadId) parts.push(`thread=${push.threadId}`);
  return parts.join(" ");
}
function messageBody(push) {
  if (typeof push.text === "string" && push.text) return push.text;
  return push.hasMedia || push.text === null ? ATTACHMENT_ONLY_BODY : "";
}
async function runFcmTransport(ctx, deps = {}) {
  const { client, identity, accountId, abortSignal, log, settings } = ctx;
  const engaged = new EngagedThreads();
  const seenEvents = /* @__PURE__ */ new Set();
  let chain = Promise.resolve();
  let pendingTurns = 0;
  const enqueueTurn = (work) => {
    if (pendingTurns >= MAX_PENDING_TURNS) {
      log(`filament-fcm: ${pendingTurns} turns already waiting; dropping this one`);
      return;
    }
    pendingTurns += 1;
    chain = chain.then(work).catch((error) => {
      log(`filament-fcm: push handling threw (continuing): ${String(error)}`);
    }).finally(() => {
      pendingTurns -= 1;
    });
  };
  const firstSighting = (eventId) => {
    if (seenEvents.has(eventId)) return false;
    seenEvents.add(eventId);
    if (seenEvents.size > MAX_SEEN_EVENTS) {
      const oldest = seenEvents.values().next().value;
      if (oldest !== void 0) seenEvents.delete(oldest);
    }
    return true;
  };
  const admitChat = (push, roomId, eventId) => {
    const isBackchannel = !!identity.ccRoomId && roomId === identity.ccRoomId;
    const item = {
      channel_id: roomId,
      thread_id: push.threadId ?? null,
      is_backchannel: isBackchannel,
      is_direct: push.branchType === "direct_message",
      messages: [
        {
          event_id: eventId,
          sender: push.senderId ?? "unknown",
          body: messageBody(push),
          ts: Date.now()
        }
      ]
    };
    if (ctx.control) {
      return isBackchannel ? () => ctx.handleControl(item) : null;
    }
    if (ctx.handleCommand && isGatewayCommandItem(item, identity.principal, identity.ccRoomId)) {
      await ctx.handleCommand(item);
      return;
    }
    const decision = decideWake(push, {
      selfMxid: identity.mxid,
      ccRoomId: identity.ccRoomId,
      engaged
    });
    if (!decision.wake) {
      log(`filament-fcm: not waking for ${eventId} in ${roomId} (${decision.reason})`);
      return null;
    }
    if (!isBackchannel && push.branchType === "channel_message") {
      engaged.record(roomId, push.threadId ?? eventId);
    }
    log(`filament-fcm: waking for ${eventId} in ${roomId} (${decision.reason})`);
    return () => runChatTurn(push, item, roomId, eventId, isBackchannel);
  };
  const runChatTurn = async (push, item, roomId, eventId, isBackchannel) => {
    const routable = {
      roomId,
      eventId,
      threadId: push.threadId ?? null,
      isBackchannel,
      isDirect: push.branchType === "direct_message"
    };
    const route = routeReply(routable);
    const statusScope = {
      channel: roomId,
      thread_id: route.tool === "reply_in_thread" ? route.args.message_id : null
    };
    await setStatus({
      ...statusScope,
      status_text: OPENING_STATUS,
      about_message_id: eventId,
      timeout_ms: STATUS_TIMEOUT_MS
    });
    let result;
    try {
      result = await ctx.runTurn(item);
    } catch (error) {
      log(`filament-fcm: turn for ${eventId} threw; dropping it: ${String(error)}`);
      return;
    } finally {
      await setStatus(statusScope);
    }
    if (result.sawError) {
      log(`filament-fcm: turn for ${eventId} failed; dropping it: ${result.errorDetail ?? "?"}`);
      return;
    }
    if (!result.sawFinal) {
      log(`filament-fcm: turn for ${eventId} produced no reply`);
      return;
    }
    if (alreadyAnswered(routable, result.repliedTo)) {
      log(`filament-fcm: a tool already replied to ${eventId}; not posting the final text`);
      return;
    }
    if (abortSignal.aborted) return;
    const res = await client.callTool(
      route.tool,
      { ...route.args, markdown_body: result.finalText },
      { signal: abortSignal }
    );
    const data = res.data;
    if (res.ok && typeof data?.event_id === "string" && data.error === void 0) {
      log(`filament-fcm: reply posted to ${roomId} via ${route.tool}`);
    } else {
      const why = res.error?.message ?? (typeof data?.error === "string" ? data.error : "no event_id");
      log(`filament-fcm: reply to ${eventId} via ${route.tool} failed: ${why}`);
    }
  };
  const setStatus = async (args) => {
    try {
      const res = await client.callTool("set_status", args, { signal: abortSignal });
      if (!res.ok) {
        log(
          `filament-fcm: status not published (${res.kind ?? "?"}: ${res.error?.message ?? "?"})`
        );
      }
    } catch (error) {
      if (!abortSignal.aborted) log(`filament-fcm: status not published: ${String(error)}`);
    }
  };
  const handlePush = (push) => {
    if (push.branchType === "io.filament.ping") {
      if (!push.nonce) return;
      void client.pong(push.nonce, { signal: abortSignal }).then((status) => log(`filament-fcm: pong sent (HTTP ${status})`)).catch((error) => log(`filament-fcm: pong failed: ${String(error)}`));
      return;
    }
    if (isInvite(push.branchType) || isVouch(push.branchType)) {
      if (ctx.control) return;
      const targetId = isVouch(push.branchType) ? push.loopId ?? push.roomId : push.roomId;
      if (!targetId) return;
      const accept = isVouch(push.branchType) ? client.acceptVouch(targetId, { signal: abortSignal }) : client.acceptInvite(targetId, { signal: abortSignal });
      void accept.then(
        (res) => log(
          `filament-fcm: ${push.branchType} ${targetId} ${res.ok ? "accepted" : `accept failed (${res.error?.code ?? "?"})`}`
        )
      ).catch(
        (error) => log(`filament-fcm: ${push.branchType} ${targetId} failed: ${String(error)}`)
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
    const turn = admitChat(push, push.roomId, push.eventId);
    if (turn) enqueueTurn(turn);
  };
  if (!ctx.control) await acceptPending(client, log, abortSignal);
  const createReceiver = deps.createReceiver ?? ((opts) => new FcmReceiver(opts));
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
      try {
        handlePush(push);
      } catch (error) {
        log(`filament-fcm: push handling threw (continuing): ${String(error)}`);
      }
    }
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
  let registered;
  try {
    registered = await client.callTool(
      "register_push_token",
      { token, platform: PUSH_PLATFORM },
      { signal: abortSignal }
    );
  } catch (error) {
    receiver.stop();
    if (abortSignal.aborted) return {};
    return { fatal: `fcm: register_push_token threw (${String(error)})` };
  }
  if (!registered.ok) {
    receiver.stop();
    if (abortSignal.aborted) return {};
    return {
      fatal: `fcm: register_push_token failed (${registered.kind ?? "?"}: ${registered.error?.message ?? "?"})`
    };
  }
  log(`filament-fcm: push token registered with Filament (project ${settings.firebase.projectId})`);
  if (!ctx.control && isFirstContact(client.instructions)) {
    const hello = await client.callTool(
      "message_principal",
      { markdown_body: "Hi \u2014 I'm connected to Filament and ready." },
      { signal: abortSignal }
    );
    log(hello.ok ? "filament-fcm: sent first-contact hello" : "filament-fcm: greeting failed");
  }
  await new Promise((resolve) => {
    if (abortSignal.aborted) return resolve();
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
  receiver.stop();
  return {};
}
export {
  runFcmTransport
};
