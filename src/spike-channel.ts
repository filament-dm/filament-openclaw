/**
 * Phase 0 channel spike (see ROADMAP.md) — THROWAWAY scaffolding, gated behind
 * FILAMENT_CHANNEL_SPIKE_ENABLED. Delete once the channel contract is proven.
 *
 * Proves the ONLY turn-waking path open to a git-installed (non-bundled) plugin:
 * register a native channel and let the gateway drive inbound → agent turn →
 * outbound. `scheduleSessionTurn` is bundled-only; `registerChannel` is not.
 *
 * It registers a minimal "filament-echo" direct-message channel. When the
 * gateway starts the channel account, it synthesizes ONE inbound DM through the
 * SDK's `dispatchInboundDirectDmWithRuntime` facade (route → envelope → record →
 * dispatch) and logs the agent's reply as delivered to the `deliver` callback.
 * A reply line in the logs = the inbound→turn→outbound loop works end-to-end
 * from a non-bundled plugin, and Phases 4–5 can build on it.
 *
 * The facade + its context (`ctx.channelRuntime`) mirror how the bundled
 * channels dispatch inbound (see openclaw `src/channels/direct-dm.ts` and its
 * plugin-sdk `direct-dm.test.ts` at the matching commit).
 *
 * Prereq: a model provider must be configured, else the woken turn dies at the
 * LLM (ProviderAuthError) — which still proves the channel start + dispatch path
 * up to the model call.
 */
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";

const CHANNEL_ID = "filament-echo";
const SPIKE_PROMPT =
  "[filament-echo] Phase 0 channel spike. If you can read this, reply with exactly: SPIKE_OK";
// Let the agent runtime + connect settle before firing the synthetic inbound.
const WAKE_DELAY_MS = 6_000;

// Loose structural view of the plugin API surface the spike touches. `any` on
// the channel/ctx keeps the real (non-resolvable-in-standalone) SDK types out of
// this throwaway module.
export interface ChannelSpikeApi {
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  registerChannel: (registration: unknown) => void;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function registerChannelSpike(api: ChannelSpikeApi): void {
  const log = (message: string) => {
    if (api.logger?.info) api.logger.info(message);
    else console.log(message);
  };

  log(
    "filament-echo: channel spike enabled (FILAMENT_CHANNEL_SPIKE_ENABLED). Throwaway Phase 0 scaffolding.",
  );

  const plugin = {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Filament Echo (spike)",
      selectionLabel: "Filament Echo",
      docsPath: "/docs/filament-echo",
      blurb: "Throwaway Phase 0 channel spike",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      // oxlint-disable-next-line typescript/no-explicit-any
      resolveAccount: (_cfg: any, accountId?: string | null) => ({
        accountId: accountId ?? "default",
      }),
    },
    gateway: {
      // oxlint-disable-next-line typescript/no-explicit-any
      startAccount: async (ctx: any) => {
        log(`filament-echo: startAccount called (account=${ctx?.accountId ?? "?"})`);
        if (!ctx?.channelRuntime) {
          log(
            "filament-echo: ctx.channelRuntime is undefined — the gateway did not pass a runtime " +
              "surface; cannot dispatch a turn (unexpected on 2026.7.1-2).",
          );
          return () => {};
        }
        const timer = setTimeout(() => {
          void (async () => {
            log("filament-echo: synthesizing one inbound DM to wake an agent turn…");
            try {
              const result = await dispatchInboundDirectDmWithRuntime({
                cfg: ctx.cfg,
                runtime: { channel: ctx.channelRuntime },
                channel: CHANNEL_ID,
                channelLabel: "Filament Echo",
                accountId: ctx.accountId ?? "default",
                peer: { kind: "direct", id: "spike-user" },
                senderId: "spike-user",
                senderAddress: `${CHANNEL_ID}:spike-user`,
                recipientAddress: `${CHANNEL_ID}:agent`,
                conversationLabel: "spike-user",
                rawBody: SPIKE_PROMPT,
                messageId: `spike-${Date.now()}`,
                commandAuthorized: true,
                deliver: async (payload: unknown) => {
                  log(`filament-echo: 🎯 REPLY delivered → ${safeJson(payload)}`);
                },
                onRecordError: (err: unknown) =>
                  log(`filament-echo: record error (continuing): ${String(err)}`),
                // oxlint-disable-next-line typescript/no-explicit-any
                onDispatchError: (err: unknown, info: any) =>
                  log(`filament-echo: dispatch error (${info?.kind ?? "?"}): ${String(err)}`),
              });
              log(
                `filament-echo: dispatch returned → sessionKey=${result?.route?.sessionKey ?? "?"} ` +
                  `agentId=${result?.route?.agentId ?? "?"}`,
              );
            } catch (error) {
              log(`filament-echo: dispatchInboundDirectDmWithRuntime threw → ${String(error)}`);
            }
          })();
        }, WAKE_DELAY_MS);
        timer.unref?.();
        return () => clearTimeout(timer);
      },
      stopAccount: async () => {},
    },
  };

  try {
    api.registerChannel({ plugin });
    log(`filament-echo: registered channel '${CHANNEL_ID}'`);
  } catch (error) {
    log(`filament-echo: registerChannel threw → ${String(error)}`);
  }
}
