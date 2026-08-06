import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
const CHANNEL_ID = "filament-echo";
const SPIKE_PROMPT = "[filament-echo] Phase 0 channel spike. If you can read this, reply with exactly: SPIKE_OK";
const WAKE_DELAY_MS = 6e3;
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function registerChannelSpike(api) {
  const log = (message) => {
    if (api.logger?.info) api.logger.info(message);
    else console.log(message);
  };
  log(
    "filament-echo: channel spike enabled (FILAMENT_CHANNEL_SPIKE_ENABLED). Throwaway Phase 0 scaffolding."
  );
  const plugin = {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Filament Echo (spike)",
      selectionLabel: "Filament Echo",
      docsPath: "/docs/filament-echo",
      blurb: "Throwaway Phase 0 channel spike"
    },
    capabilities: { chatTypes: ["direct"] },
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
        log(`filament-echo: startAccount called (account=${ctx?.accountId ?? "?"})`);
        if (!ctx?.channelRuntime) {
          log(
            "filament-echo: ctx.channelRuntime is undefined \u2014 the gateway did not pass a runtime surface; cannot dispatch a turn (unexpected on 2026.7.1-2)."
          );
          return () => {
          };
        }
        const timer = setTimeout(() => {
          void (async () => {
            log("filament-echo: synthesizing one inbound DM to wake an agent turn\u2026");
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
                deliver: async (payload) => {
                  log(`filament-echo: \u{1F3AF} REPLY delivered \u2192 ${safeJson(payload)}`);
                },
                onRecordError: (err) => log(`filament-echo: record error (continuing): ${String(err)}`),
                // oxlint-disable-next-line typescript/no-explicit-any
                onDispatchError: (err, info) => log(`filament-echo: dispatch error (${info?.kind ?? "?"}): ${String(err)}`)
              });
              log(
                `filament-echo: dispatch returned \u2192 sessionKey=${result?.route?.sessionKey ?? "?"} agentId=${result?.route?.agentId ?? "?"}`
              );
            } catch (error) {
              log(`filament-echo: dispatchInboundDirectDmWithRuntime threw \u2192 ${String(error)}`);
            }
          })();
        }, WAKE_DELAY_MS);
        timer.unref?.();
        return () => clearTimeout(timer);
      },
      stopAccount: async () => {
      }
    }
  };
  try {
    api.registerChannel({ plugin });
    log(`filament-echo: registered channel '${CHANNEL_ID}'`);
  } catch (error) {
    log(`filament-echo: registerChannel threw \u2192 ${String(error)}`);
  }
}
export {
  registerChannelSpike
};
//# sourceMappingURL=spike-channel.js.map
