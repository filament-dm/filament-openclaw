import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { resolveMcpSettings, runConnect } from "./connect.js";
import { dispatchWorkItemTurn } from "./inbound-dispatch.js";
import { runPollLoop } from "./poll-work.js";
import { loadIdentity } from "./token-store.js";
const FILAMENT_CHANNEL_ID = "filament";
function publishSucceeded(data) {
  if (!data || typeof data !== "object") return false;
  const d = data;
  return typeof d.event_id === "string" && d.event_id.length > 0 && d.error === void 0;
}
function registerFilamentChannel(api, onConnectionChange = () => {
}) {
  const log = (message) => {
    if (api.logger?.info) api.logger.info(message);
    else console.log(message);
  };
  const mcp = resolveMcpSettings(api.pluginConfig);
  const plugin = {
    id: FILAMENT_CHANNEL_ID,
    meta: {
      id: FILAMENT_CHANNEL_ID,
      label: "Filament",
      selectionLabel: "Filament",
      docsPath: "/channels/filament",
      blurb: "Connects the agent to Filament via the poll_work MCP transport"
    },
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => ["default"],
      // oxlint-disable-next-line typescript/no-explicit-any
      resolveAccount: (_cfg, accountId) => ({
        accountId: accountId ?? "default"
      })
    },
    gateway: {
      // oxlint-disable-next-line typescript/no-explicit-any
      startAccount: async (ctx) => {
        let connection = null;
        const abortSignal = ctx.abortSignal;
        const dispatchItem = async (item) => {
          const replyWith = item.reply_with;
          if (!replyWith) {
            return { kind: "ambiguous" };
          }
          if (!connection) {
            return { kind: "error", diagnostic: "item arrived before connect finished" };
          }
          if (!ctx.channelRuntime) {
            return {
              kind: "error",
              diagnostic: "ctx.channelRuntime unavailable; cannot wake a turn"
            };
          }
          const identity = loadIdentity();
          let result;
          try {
            result = await dispatchWorkItemTurn({
              cfg: ctx.cfg,
              channelRuntime: ctx.channelRuntime,
              channel: FILAMENT_CHANNEL_ID,
              channelLabel: "Filament",
              accountId: ctx.accountId ?? "default",
              peerKind: item.is_backchannel ? "direct" : "group",
              channelId: item.channel_id,
              threadId: item.thread_id,
              messages: item.messages,
              recipientAddress: identity?.mxid ?? `${FILAMENT_CHANNEL_ID}:agent`,
              conversationLabel: item.channel_id,
              // Filament (not OpenClaw) decides who can reach the agent; this
              // only ever authorizes the backchannel/control-plane item, never
              // an arbitrary conversation (see the plan's item 5).
              commandAuthorized: item.is_backchannel === true,
              log
            });
          } catch (error) {
            return { kind: "error", diagnostic: `dispatch threw: ${String(error)}` };
          }
          if (result.sawError) {
            return {
              kind: "error",
              diagnostic: result.errorDetail ?? "dispatch reported an error"
            };
          }
          if (result.sawFinal) {
            if (abortSignal.aborted) {
              return { kind: "error", diagnostic: "aborted before publish" };
            }
            const publishRes = await connection.client.replyWith(replyWith, result.finalText, {
              signal: abortSignal
            });
            if (!publishRes.ok || !publishSucceeded(publishRes.data)) {
              return {
                kind: "error",
                diagnostic: `publish failed/ambiguous (${publishRes.kind ?? "?"}: ${publishRes.error?.message ?? "no event_id"})`
              };
            }
            log(`filament: reply published to ${item.channel_id} via ${replyWith.tool}`);
            return { kind: "published" };
          }
          if (result.sawSkip) {
            return { kind: "silent" };
          }
          log(
            `filament: turn produced no text and no explicit skip signal for ${item.channel_id}; leaving unacknowledged`
          );
          return { kind: "ambiguous" };
        };
        let token = "";
        if (mcp.tokenInput !== void 0) {
          const resolved = await resolveConfiguredSecretInputString({
            // oxlint-disable-next-line typescript/no-explicit-any
            config: api.config,
            env: process.env,
            value: mcp.tokenInput,
            path: "plugins.entries.filament-fcm.config.connectToken"
          });
          token = resolved.value ?? "";
          if (!token) {
            log(
              `filament: connect token did not resolve${resolved.unresolvedRefReason ? ` (${resolved.unresolvedRefReason})` : ""}`
            );
          }
        }
        if (token) {
          try {
            connection = await runConnect({
              mcpUrl: mcp.mcpUrl,
              token,
              log,
              abortSignal
            });
            onConnectionChange(connection);
          } catch (error) {
            log(`filament: connect failed: ${String(error)}`);
            connection = null;
          }
        } else {
          log("filament: no connect token configured; channel idle (set config.connectToken)");
        }
        if (connection) {
          const { fatal } = await runPollLoop({
            client: connection.client,
            abortSignal,
            log,
            dispatchItem,
            waitSeconds: mcp.pollWaitSeconds
          });
          if (fatal) {
            log(`filament: account entering a fatal/paused state: ${fatal}`);
            ctx.setStatus?.({
              accountId: ctx.accountId ?? "default",
              connected: false,
              statusState: "error",
              restartPending: false
            });
          }
        }
        if (!abortSignal.aborted) {
          await new Promise((resolve) => {
            if (abortSignal.aborted) return resolve();
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        connection?.stop();
        onConnectionChange(null);
      },
      stopAccount: async () => {
        onConnectionChange(null);
      }
    }
  };
  try {
    api.registerChannel({ plugin });
    log(`filament: registered channel '${FILAMENT_CHANNEL_ID}'`);
  } catch (error) {
    log(`filament: registerChannel threw \u2192 ${String(error)}`);
  }
}
export {
  FILAMENT_CHANNEL_ID,
  registerFilamentChannel
};
//# sourceMappingURL=channel.js.map
