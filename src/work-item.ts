/**
 * The unit of inbound work both transports hand to the shared layer.
 *
 * The shape is `poll_work`'s own item minus `reply_with`, in its wire
 * (snake_case) spelling: the poll transport passes items through untouched,
 * and the FCM transport builds one from each push. Where the reply goes is
 * each transport's business — `reply_with` for poll, src/transports/fcm/
 * reply-route.ts for FCM — so it is not part of the shared item.
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
  /** A 1:1 room that is not the backchannel. poll_work never sets it. */
  is_direct?: boolean;
  messages: WorkMessage[];
}

/** What happened when an item was dispatched. */
export type DispatchOutcome =
  | { kind: "published" }
  | { kind: "silent" } // deliberate silence, evidenced by the SDK: ack it.
  | { kind: "ambiguous" } // no finals, no explicit skip signal, no error: leave it be (no ack, no pause).
  | { kind: "error"; diagnostic: string }; // no ack, no publish; the account pauses.
