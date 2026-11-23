/**
 * The channel/transport contract. The transport owns how work reaches one account, whether it wakes
 * the agent and where the reply goes; the channel hands in everything shared, which keeps the
 * transport testable without a gateway.
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
  /** The agent reacted to a message during the turn. */
  reacted: boolean;
  /** What write tools posted during the turn (their markdown bodies). */
  posted: readonly string[];
  /** Local directories the turn's agent may send files from (`mediaUrls` that are paths). */
  mediaLocalRoots: readonly string[];
}

export interface TurnOptions {
  /** Ends the turn: OpenClaw's reply operation stops at its next check. */
  abortSignal?: AbortSignal;
  /**
   * Each step the turn reaches: OpenClaw's turn stages as `<stage>:<event>` ("record:done",
   * "dispatch:start"), "run:start" and "model:selected" once the agent's run begins, then
   * "deliver:<tool|block|final>", "skip" and "error" as the dispatcher reports them.
   */
  onProgress?: (step: string) => void;
}

export interface TransportContext {
  accountId: string;
  client: FilamentMcpClient;
  identity: ResolvedIdentity;
  settings: McpSettings;
  abortSignal: AbortSignal;
  log: (message: string) => void;
  /** Throws only when the dispatcher itself throws. `media`: attachments saved for the turn. */
  runTurn: (item: WorkItem, media?: InboundMedia[], opts?: TurnOptions) => Promise<TurnResult>;
  /**
   * The plugin's own answer to a `/filament` command from the principal in its backchannel
   * (`isBackchannelCommandItem`): the item never wakes a turn. Never throws.
   */
  handleCommand?: (item: WorkItem) => Promise<void>;
}

export interface TransportResult {
  /** Absent on a clean abort. */
  fatal?: string;
}
