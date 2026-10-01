/**
 * The channel/transport contract. A transport owns how work reaches one account, whether it wakes
 * the agent and where the reply goes; the channel hands in everything shared. The two transports
 * never import each other.
 */
import type { FilamentMcpClient } from "../mcp-client.js";
import type { ResolvedIdentity } from "../onboarding-core.js";
import type { McpSettings } from "../settings.js";
import type { DispatchTurnResult } from "../turn.js";
import type { WorkItem } from "../work-item.js";

export interface TurnResult extends DispatchTurnResult {
  /** Where write tools replied: a room id, `"*"` for a thread reply, or `"backchannel"`. */
  repliedTo: ReadonlySet<string>;
}

export interface TransportContext {
  accountId: string;
  client: FilamentMcpClient;
  identity: ResolvedIdentity;
  settings: McpSettings;
  /** Its items go to `handleControl`, never to a turn. */
  control: boolean;
  abortSignal: AbortSignal;
  log: (message: string) => void;
  /** Throws only when the dispatcher itself throws. */
  runTurn: (item: WorkItem) => Promise<TurnResult>;
  /** Never throws. */
  handleControl: (item: WorkItem) => Promise<void>;
}

export interface TransportResult {
  /** Absent on a clean abort. */
  fatal?: string;
}

export type RunTransport = (ctx: TransportContext) => Promise<TransportResult>;
