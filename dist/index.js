import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildSnapshot, createReceiver, resolveFcmConfig } from "./src/fcm.js";
import { registerConformanceRoutes } from "./src/conformance-http.js";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { resolveMcpSettings, runConnect } from "./src/connect.js";
import { registerChannelSpike } from "./src/spike-channel.js";
var index_default = definePluginEntry({
  id: "filament-fcm",
  name: "Filament (FCM)",
  description: "Connects an OpenClaw agent to Filament: receives messages as Firebase Cloud Messaging (FCM) pushes and (in later iterations) replies through Filament's MCP-over-HTTP agents API.",
  register(api) {
    api.registerTool({
      name: "filament_hello",
      description: "Say hello from the Filament (FCM) plugin.",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: 'Who to greet. Defaults to "world".' }))
      }),
      outputSchema: Type.Object({ greeting: Type.String() }, { additionalProperties: false }),
      async execute(_id, params) {
        const who = params.name?.trim() || "world";
        const greeting = `Hello, ${who}! \u2014 from the Filament (FCM) OpenClaw plugin.`;
        return {
          content: [{ type: "text", text: greeting }],
          details: { greeting }
        };
      }
    });
    api.registerTool({
      name: "filament_fcm_status",
      description: "Report the Firebase project this agent would register with to receive Filament pushes. Constructs the FCM receiver but does not connect to Google's servers.",
      parameters: Type.Object({}),
      outputSchema: Type.Object(
        {
          projectId: Type.String(),
          messagingSenderId: Type.String(),
          appId: Type.String(),
          receiverReady: Type.Boolean()
        },
        { additionalProperties: false }
      ),
      async execute() {
        const config = resolveFcmConfig();
        const receiver = createReceiver(config);
        let receiverReady = false;
        try {
          receiverReady = Boolean(receiver);
        } finally {
          receiver.destroy?.();
        }
        const details = {
          projectId: config.projectId,
          messagingSenderId: config.messagingSenderId,
          appId: config.appId,
          receiverReady
        };
        return {
          content: [
            {
              type: "text",
              text: `FCM receiver ready for Firebase project "${config.projectId}" (sender ${config.messagingSenderId}). Not yet connected \u2014 that arrives in a later iteration.`
            }
          ],
          details
        };
      }
    });
    let connection = null;
    const mcp = resolveMcpSettings(api.pluginConfig);
    if (mcp.tokenInput !== void 0) {
      api.registerService({
        id: "filament-connect",
        start: async (ctx) => {
          const log = (message) => ctx.logger.info?.(message);
          const resolved = await resolveConfiguredSecretInputString({
            config: api.config,
            env: process.env,
            value: mcp.tokenInput,
            path: "plugins.entries.filament-fcm.config.connectToken"
          });
          const token = resolved.value;
          if (!token) {
            log(
              `filament-connect: connect token did not resolve${resolved.unresolvedRefReason ? ` (${resolved.unresolvedRefReason})` : ""}; skipping`
            );
            return;
          }
          connection = await runConnect({ mcpUrl: mcp.mcpUrl, token, log });
        },
        stop: () => {
          connection?.stop();
          connection = null;
        }
      });
    }
    if (process.env.FILAMENT_CONFORMANCE_ENABLED) {
      registerConformanceRoutes(api, {
        getTokenSnapshot: () => connection ? connection.snapshot() : buildSnapshot(false)
      });
    }
    if (process.env.FILAMENT_CHANNEL_SPIKE_ENABLED) {
      registerChannelSpike(api);
    }
  }
});
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
