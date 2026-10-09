/**
 * The channel/transport contract. A transport owns how work reaches one account, whether it wakes
 * the agent and where the reply goes; the channel hands in everything shared. The two transports
 * never import each other.
 */
import type { FilamentMcpClient } from "../mcp-client.js";
import type { InboundMedia } from "../media.js";
import type { ResolvedIdentity } from "../onboarding-core.js";
import type { McpSettings } from "../settings.js";
import type { DispatchTurnResult } from "../turn.js";
import type { WorkItem } from "../work-item.js";

export interface TurnResult extends DispatchTurnResult {
  /** Where write tools replied: a room id, `"*"` for a thread reply, or `"backchannel"`. */
  repliedTo: ReadonlySet<string>;
  /** Local directories the turn's agent may send files from (`mediaUrls` that are paths). */
  mediaLocalRoots: readonly string[];
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
  /** Throws only when the dispatcher itself throws. `media`: attachments saved for the turn. */
  runTurn: (item: WorkItem, media?: InboundMedia[]) => Promise<TurnResult>;
  /** Never throws. */
  handleControl: (item: WorkItem) => Promise<void>;
  /**
   * A connected agent's own answer to a `/filament` command from its principal in its backchannel
   * (`isGatewayCommandItem`): the item never wakes a turn. Absent on control and pending accounts.
   * Never throws.
   */
  handleCommand?: (item: WorkItem) => Promise<void>;
}

export interface TransportResult {
  /** Absent on a clean abort. */
  fatal?: string;
}

export type RunTransport = (ctx: TransportContext) => Promise<TransportResult>;
