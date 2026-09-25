/**
 * The contract between the channel (src/channel.ts) and a transport.
 *
 * A transport owns how work reaches one account and how it is acknowledged:
 * receiving, deciding whether an item wakes the agent, where the reply goes.
 * The channel owns everything shared — connecting, running the agent turn,
 * the tools, the gateway commands — and hands those in here.
 *
 * `run` returns when the account should stop: on abort (no `fatal`), or on a
 * condition the account must surface (`fatal`). The two transports never
 * import each other.
 */
import type { FilamentMcpClient } from "../mcp-client.js";
import type { ResolvedIdentity } from "../onboarding-core.js";
import type { McpSettings } from "../settings.js";
import type { DispatchTurnResult } from "../turn.js";
import type { WorkItem } from "../work-item.js";

/** A finished turn, plus where the agent already replied through a tool. */
export interface TurnResult extends DispatchTurnResult {
  /**
   * Conversations a `filament_*` write tool posted to during the turn: a room
   * id, `"*"` for a thread reply (whose room the call doesn't name), or
   * `"backchannel"` for `message_principal`.
   */
  repliedTo: ReadonlySet<string>;
}

export interface TransportContext {
  accountId: string;
  client: FilamentMcpClient;
  identity: ResolvedIdentity;
  settings: McpSettings;
  /** A gateway control account: its items go to `handleControl`, never to a turn. */
  control: boolean;
  abortSignal: AbortSignal;
  log: (message: string) => void;
  /** Run one agent turn for an item. Throws only when the dispatcher itself throws. */
  runTurn: (item: WorkItem) => Promise<TurnResult>;
  /** Apply a control account's item (src/gateway.ts). Never throws. */
  handleControl: (item: WorkItem) => Promise<void>;
}

export interface TransportResult {
  /** Present when the account should surface why it stopped. Absent on a clean abort. */
  fatal?: string;
}

export type RunTransport = (ctx: TransportContext) => Promise<TransportResult>;
