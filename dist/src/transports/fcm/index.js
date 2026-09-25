import { isFirstContact } from "../../onboarding-core.js";
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
function loopIds(data, key) {
  if (!data || typeof data !== "object") return [];
  const list = data[key];
  if (!Array.isArray(list)) return [];
  return list.map(
    (item) => item && typeof item === "object" ? item.loop_id : void 0
  ).filter((id) => typeof id === "string" && id.length > 0);
}
async function acceptPending(client, log, signal) {
  const sweep = async (kind, list, accept) => {
    try {
      const res = await list();
      for (const loopId of res.ok ? loopIds(res.data, kind) : []) {
        const accepted = await accept(loopId);
        log(
          `filament-fcm: accept ${kind === "invites" ? "invite" : "vouch"} ${loopId} ${accepted.ok ? "ok" : `failed (${accepted.error?.code ?? "?"})`}`
        );
      }
    } catch (error) {
      log(`filament-fcm: pending ${kind} sweep failed (continuing): ${String(error)}`);
    }
  };
  await sweep(
    "invites",
    () => client.listPendingInvites({ signal }),
    (id) => client.acceptInvite(id, { signal })
  );
  await sweep(
    "vouches",
    () => client.listVouches({ signal }),
    (id) => client.acceptVouch(id, { signal })
  );
}
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
  return push.hasMedia || push.text === null ? "(an attachment, with no text)" : "";
}
async function runFcmTransport(ctx, deps = {}) {
  const { client, identity, accountId, abortSignal, log, settings } = ctx;
  const engaged = new EngagedThreads();
  const seenEvents = /* @__PURE__ */ new Set();
  let chain = Promise.resolve();
  const enqueue = (work) => {
    chain = chain.then(work).catch((error) => {
      log(`filament-fcm: push handling threw (continuing): ${String(error)}`);
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
  const handleChat = async (push, roomId, eventId) => {
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
      if (isBackchannel) await ctx.handleControl(item);
      return;
    }
    const decision = decideWake(push, {
      selfMxid: identity.mxid,
      ccRoomId: identity.ccRoomId,
      engaged
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
    const routable = {
      roomId,
      eventId,
      threadId: push.threadId ?? null,
      isBackchannel,
      isDirect: push.branchType === "direct_message"
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
  const handlePush = async (push) => {
    if (push.branchType === "io.filament.ping") {
      if (!push.nonce) return;
      const status = await client.pong(push.nonce, { signal: abortSignal });
      log(`filament-fcm: pong sent (HTTP ${status})`);
      return;
    }
    if (isInvite(push.branchType) || isVouch(push.branchType)) {
      if (ctx.control) return;
      const targetId = isVouch(push.branchType) ? push.loopId ?? push.roomId : push.roomId;
      if (!targetId) return;
      const res = isVouch(push.branchType) ? await client.acceptVouch(targetId, { signal: abortSignal }) : await client.acceptInvite(targetId, { signal: abortSignal });
      log(
        `filament-fcm: ${push.branchType} ${targetId} ${res.ok ? "accepted" : `accept failed (${res.error?.code ?? "?"})`}`
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
      enqueue(() => handlePush(push));
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
  const registered = await client.callTool(
    "register_push_token",
    { token, platform: PUSH_PLATFORM },
    { signal: abortSignal }
  );
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
//# sourceMappingURL=index.js.map
