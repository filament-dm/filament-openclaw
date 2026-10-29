/**
 * The unit of inbound work: `poll_work`'s item minus `reply_with`, in its wire (snake_case)
 * spelling, so the transport passes items through untouched.
 */

/** An attachment on a message: fetch its bytes with `FilamentMcpClient.downloadMedia`. */
export interface WorkMedia {
  mxc_url: string;
  mimetype?: string;
  filename?: string;
  size?: number;
}

export interface WorkMessage {
  event_id: string;
  sender: string;
  body: string;
  ts: number;
  media?: WorkMedia[];
  /** An @-mention of the agent. */
  is_mention?: boolean;
  /** Once the server has judged it: the message reads as wanting an answer. */
  reply_expected?: boolean;
  /** Sent by another agent rather than a person. */
  sender_is_agent?: boolean;
}

export interface WorkItem {
  channel_id: string;
  thread_id: string | null;
  is_backchannel: boolean;
  /** A room created as a DM, other than the backchannel. */
  is_direct?: boolean;
  /**
   * What the server says about the room (filament-dm/synapse#1156): its name, its loop's name,
   * and each sender's display name by user id. `sender_names` present means the server sent them; older servers send none.
   */
  channel_name?: string;
  loop_name?: string;
  sender_names?: Record<string, string>;
  messages: WorkMessage[];
}

/**
 * How OpenClaw files the turn. Only the principal's backchannel is a direct chat, which OpenClaw's
 * default `session.dmScope` puts in the agent's main session, as it does the owner's DMs on any
 * channel. Every other room, a DM from someone else included, is a group with a session of its
 * own: other people's words never reach the owner's main conversation.
 */
export function turnPeerKind(item: Pick<WorkItem, "is_backchannel">): "direct" | "group" {
  return item.is_backchannel ? "direct" : "group";
}

/**
 * Whether a group turn must end in an answer, as OpenClaw's `WasMentioned`. With group silence
 * allowed (`surfaces.filament.silentReply.group`), only a turn marked this way refuses NO_REPLY.
 * Only people can require an answer: agents that had to answer each other could keep a room going
 * forever, and silence is how an agent ends that. Among people's messages the server's judgement
 * wins: a passing @-mention it judged as not wanting an answer may go unanswered. Without one, an
 * @-mention or a DM counts. The backchannel never asks: it is direct, and OpenClaw always requires
 * a reply there.
 */
export function turnWasMentioned(
  item: Pick<WorkItem, "is_backchannel" | "is_direct" | "messages">,
): boolean | undefined {
  if (item.is_backchannel) return undefined;
  const fromPeople = item.messages.filter((m) => m.sender_is_agent !== true);
  if (fromPeople.length === 0) return false;
  const judged = fromPeople.filter((m) => typeof m.reply_expected === "boolean");
  if (judged.length > 0) return judged.some((m) => m.reply_expected === true);
  return item.is_direct === true || fromPeople.some((m) => m.is_mention === true);
}

export const ATTACHMENT_ONLY_BODY = "(an attachment, with no text)";

export type DispatchOutcome =
  | { kind: "published" }
  | { kind: "silent" } // deliberate silence, evidenced by the SDK: ack it.
  | { kind: "ambiguous" } // no finals, no explicit skip signal, no error: leave it be (no ack, no pause).
  | { kind: "dropped"; diagnostic: string } // the turn failed, or the server refused the reply: ack it.
  | { kind: "retry"; diagnostic: string } // the reply may not have landed (network, 5xx): no ack, back off.
  | { kind: "fatal"; diagnostic: string } // the bearer was rejected: no ack; the account stops.
  | { kind: "held"; diagnostic: string }; // not dispatched yet, on purpose: no ack, poll again shortly.
