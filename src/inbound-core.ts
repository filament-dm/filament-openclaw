/**
 * Pure decoder for Filament DirectPusher FCM payloads — no OpenClaw or eneris
 * imports, so it is unit-testable in isolation.
 *
 * Filament's DirectPusher wraps a structured payload in the FCM data dict (the
 * `message.data` of an `@eneris/push-receiver` MessageEnvelope):
 *
 *   data = {
 *     body: "<JSON-serialized PushPayload>",   // the real content
 *     room_name, message_text, badge_count, from_directpusher, badge_only, ...
 *   }
 *
 *   PushPayload = {
 *     event_id, room_id, is_direct,
 *     branch: {
 *       type: "direct_message" | "channel_message" | "add_to_channel"
 *           | "add_to_space" | "knock_invite_received" | "reaction" | ...,
 *       sender, sender_id, content: { text } | null, channel, thread_id,
 *       is_mention_of_recipient, is_everyone_mention, key, target_event_id,
 *     },
 *   }
 *
 * Non-message payloads (e.g. "io.filament.ping") carry the type at the top level
 * and have no `branch`. Mirrors the Python plugin's `parse_envelope`.
 */

/** A decoded inbound push, normalized from the DirectPusher envelope. */
export interface DecodedPush {
  /** The branch type, or the top-level type for non-message payloads (pings). */
  branchType: string;
  eventId?: string;
  roomId?: string;
  isDirect?: boolean;
  /** Sender display name. */
  sender?: string;
  /** Sender mxid. */
  senderId?: string;
  /** Message text (null for media-only messages). */
  text?: string | null;
  /** Channel/room display name. */
  channel?: string;
  threadId?: string | null;
  isMentionOfRecipient?: boolean;
  isEveryoneMention?: boolean;
  /** Reaction emoji (reaction branches). */
  key?: string;
  /** Event the reaction targets (reaction branches). */
  targetEventId?: string;
  /** Loop (space) id on a vouch branch (knock_invite_received). */
  loopId?: string;
  /** Liveness ping nonce (io.filament.ping). */
  nonce?: string;
  /** The parsed PushPayload (whatever shape it had). */
  raw: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * Decode one FCM MessageEnvelope's data dict into a DecodedPush, or null when
 * there is nothing actionable (a badge-only refresh, or an unparseable body).
 * Accepts a loose shape so it does not depend on the eneris types.
 */
export function decodeDirectPusher(env: {
  message?: { data?: Record<string, unknown> };
}): DecodedPush | null {
  const data = env?.message?.data;
  if (!data) return null;

  // FCM may double-wrap under a nested "data"; the Python plugin unwraps the
  // same way (`data.get("data", data)`).
  const inner = asRecord(data.data) ?? data;

  // Badge-count-only refreshes are not real messages.
  if (bool(inner.badge_only) === true) return null;

  const rawBody = str(inner.body);
  let payload: Record<string, unknown> | undefined;
  if (rawBody) {
    try {
      payload = asRecord(JSON.parse(rawBody));
    } catch {
      payload = undefined;
    }
  }
  // Some payloads (e.g. pings) may not use a JSON `body`; fall back to the dict.
  payload = payload ?? inner;

  const branch = asRecord(payload.branch);
  const branchType = str(branch?.type) ?? str(payload.type);
  if (!branchType) return null;

  // `content` is `{ text } | null` when present (null = media-only, ENG-603);
  // absent means we don't know, so leave text undefined.
  let text: string | null | undefined;
  if (branch && "content" in branch) {
    const content = asRecord(branch.content);
    text = content ? (str(content.text) ?? null) : null;
  }

  return {
    branchType,
    eventId: str(payload.event_id),
    roomId: str(payload.room_id),
    isDirect: bool(payload.is_direct),
    sender: str(branch?.sender),
    senderId: str(branch?.sender_id),
    text,
    channel: str(branch?.channel),
    threadId: str(branch?.thread_id) ?? null,
    isMentionOfRecipient: bool(branch?.is_mention_of_recipient),
    isEveryoneMention: bool(branch?.is_everyone_mention),
    key: str(branch?.key),
    targetEventId: str(branch?.target_event_id),
    loopId: str(branch?.loop_id),
    nonce: str(payload.nonce),
    raw: payload,
  };
}

/** True for branch types that represent an inbound chat message worth waking on. */
export function isChatMessage(branchType: string): boolean {
  return branchType === "direct_message" || branchType === "channel_message";
}

/** True for a push inviting the agent into a channel or space (loop). */
export function isInvite(branchType: string): boolean {
  return branchType === "add_to_channel" || branchType === "add_to_space";
}

/** True for a vouch push (a member knocked the agent into a loop). */
export function isVouch(branchType: string): boolean {
  return branchType === "knock_invite_received";
}
