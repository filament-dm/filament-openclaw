/**
 * The unit of inbound work both transports share: `poll_work`'s item minus `reply_with`, in its
 * wire (snake_case) spelling, so the poll transport passes items through untouched.
 */

export interface WorkMessage {
  event_id: string;
  sender: string;
  body: string;
  ts: number;
}

export interface WorkItem {
  channel_id: string;
  thread_id: string | null;
  is_backchannel: boolean;
  /** A room created as a DM, other than the backchannel. */
  is_direct?: boolean;
  messages: WorkMessage[];
}

export const ATTACHMENT_ONLY_BODY = "(an attachment, with no text)";

export type DispatchOutcome =
  | { kind: "published" }
  | { kind: "silent" } // deliberate silence, evidenced by the SDK: ack it.
  | { kind: "ambiguous" } // no finals, no explicit skip signal, no error: leave it be (no ack, no pause).
  | { kind: "dropped"; diagnostic: string } // the turn failed, or the server refused the reply: ack it.
  | { kind: "retry"; diagnostic: string } // the reply may not have landed (network, 5xx): no ack, back off.
  | { kind: "fatal"; diagnostic: string }; // the bearer was rejected: no ack; the account stops.
