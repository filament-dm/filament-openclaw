/**
 * Decodes Filament's FCM data payloads. The content is a JSON-serialized payload in `data.body`;
 * non-message payloads (such as `io.filament.ping`) carry their type at the top level, with no
 * `branch`.
 */

export interface DecodedPush {
  branchType: string;
  eventId?: string;
  roomId?: string;
  isDirect?: boolean;
  /** Display name; `senderId` is the mxid. */
  sender?: string;
  senderId?: string;
  /** Null for a media-only message. */
  text?: string | null;
  channel?: string;
  threadId?: string | null;
  isMentionOfRecipient?: boolean;
  isEveryoneMention?: boolean;
  isReplyToRecipient?: boolean;
  senderIsAgent?: boolean;
  hasMedia?: boolean;
  /** Reaction emoji. */
  key?: string;
  targetEventId?: string;
  loopId?: string;
  nonce?: string;
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

/** Null when there is nothing actionable: a badge-only refresh, or an unparseable body. */
export function decodeDirectPusher(env: {
  message?: { data?: Record<string, unknown> };
}): DecodedPush | null {
  const data = env?.message?.data;
  if (!data) return null;

  // FCM may double-wrap under a nested "data".
  const inner = asRecord(data.data) ?? data;

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
  // Some payloads (e.g. pings) have no JSON `body`.
  payload = payload ?? inner;

  const branch = asRecord(payload.branch);
  const branchType = str(branch?.type) ?? str(payload.type);
  if (!branchType) return null;

  // `content: null` means media-only; an absent `content` leaves the text unknown.
  let text: string | null | undefined;
  if (branch && "content" in branch) {
    const content = asRecord(branch.content);
    text = content ? (str(content.text) ?? null) : null;
  }

  return {
    branchType,
    eventId: str(payload.event_id) ?? str(branch?.event_id),
    roomId: str(payload.room_id),
    isDirect: bool(payload.is_direct),
    sender: str(branch?.sender),
    senderId: str(branch?.sender_id),
    text,
    channel: str(branch?.channel),
    threadId: str(branch?.thread_id) ?? null,
    isMentionOfRecipient: bool(branch?.is_mention_of_recipient),
    isEveryoneMention: bool(branch?.is_everyone_mention),
    isReplyToRecipient: bool(branch?.is_reply_to_recipient),
    senderIsAgent: bool(branch?.sender_is_agent),
    hasMedia: bool(branch?.has_media),
    key: str(branch?.key),
    targetEventId: str(branch?.target_event_id),
    loopId: str(branch?.loop_id),
    nonce: str(payload.nonce),
    raw: payload,
  };
}

export function isChatMessage(branchType: string): boolean {
  return branchType === "direct_message" || branchType === "channel_message";
}

export function isInvite(branchType: string): boolean {
  return branchType === "add_to_channel" || branchType === "add_to_space";
}

/** A vouch: a member knocked the agent into a loop. */
export function isVouch(branchType: string): boolean {
  return branchType === "knock_invite_received";
}
