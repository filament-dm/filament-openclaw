// Filament (FCM) plugin entrypoint. Registers the plugin's OpenClaw tools.
//
// This is the hello-world scaffold. It proves three things end to end:
//   1. the plugin loads and registers MCP tools with OpenClaw,
//   2. the @eneris/push-receiver dependency resolves and constructs, and
//   3. the Firebase config matches the project filament-hermes registers with.
// Everything else (live FCM connection, MCP-over-HTTP replies, credential
// persistence) is built on top of this in later iterations.
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { buildSnapshot, createReceiver, FcmConnection, resolveFcmConfig } from "./src/fcm.js";
import { registerConformanceRoutes } from "./src/conformance-http.js";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";

import { resolveMcpSettings, runOnboarding } from "./src/onboarding.js";

export default definePluginEntry({
  id: "filament-fcm",
  name: "Filament (FCM)",
  description:
    "Connects an OpenClaw agent to Filament: receives messages as Firebase " +
    "Cloud Messaging (FCM) pushes and (in later iterations) replies through " +
    "Filament's MCP-over-HTTP agents API.",
  register(api) {
    // A trivial tool proving the plugin loads and can register MCP tools.
    api.registerTool({
      name: "filament_hello",
      description: "Say hello from the Filament (FCM) plugin.",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: 'Who to greet. Defaults to "world".' })),
      }),
      outputSchema: Type.Object({ greeting: Type.String() }, { additionalProperties: false }),
      async execute(_id, params) {
        const who = params.name?.trim() || "world";
        const greeting = `Hello, ${who}! — from the Filament (FCM) OpenClaw plugin.`;
        return {
          content: [{ type: "text", text: greeting }],
          details: { greeting },
        };
      },
    });

    // A read-only tool that resolves the FCM registration config and
    // constructs the push receiver (without connecting), proving the
    // @eneris/push-receiver dependency is wired and compatible with the
    // Firebase project filament-hermes uses.
    api.registerTool({
      name: "filament_fcm_status",
      description:
        "Report the Firebase project this agent would register with to " +
        "receive Filament pushes. Constructs the FCM receiver but does not " +
        "connect to Google's servers.",
      parameters: Type.Object({}),
      outputSchema: Type.Object(
        {
          projectId: Type.String(),
          messagingSenderId: Type.String(),
          appId: Type.String(),
          receiverReady: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      async execute() {
        const config = resolveFcmConfig();
        // Construct (do not connect) to confirm the receiver initialises, then
        // tear it down so nothing lingers.
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
          receiverReady,
        };
        return {
          content: [
            {
              type: "text",
              text:
                `FCM receiver ready for Firebase project ` +
                `"${config.projectId}" (sender ${config.messagingSenderId}). ` +
                `Not yet connected — that arrives in a later iteration.`,
            },
          ],
          details,
        };
      },
    });

    // ── Opt-in: live FCM registration (env FILAMENT_FCM_ENABLED) ────────
    // Off by default. When enabled, register with FCM on startup and cache the
    // token in the plugin-state store so it survives restarts.
    let connection: FcmConnection | null = null;
    if (process.env.FILAMENT_FCM_ENABLED) {
      api.registerService({
        id: "filament-fcm",
        start: async (ctx) => {
          connection = new FcmConnection(undefined, (message) => ctx.logger.info?.(message));
          await connection.start();
        },
        stop: () => {
          connection?.stop();
          connection = null;
        },
      });
    }

    // ── Opt-in: conformance control surface (env FILAMENT_CONFORMANCE_ENABLED) ─
    // Off by default. Exposes GET /conformance/manifest and POST /conformance/op
    // on the gateway's HTTP server (gateway bearer auth). Reads the cached token,
    // reporting no_cached_token until FCM registration above has completed.
    if (process.env.FILAMENT_CONFORMANCE_ENABLED) {
      registerConformanceRoutes(api, {
        getTokenSnapshot: () => (connection ? connection.snapshot() : buildSnapshot(false)),
      });
    }

    // ── Onboarding: complete the Filament connect flow ─────────────────
    // Off until configured. When a connect token is present (config
    // `connectToken`, or env FILAMENT_MCP_TOKEN), poll get_self over MCP until
    // the app finalizes the agent, then persist the identity (principal +
    // backchannel). Mirrors Hermes' setup_cli finalization poll.
    const mcp = resolveMcpSettings(api.pluginConfig);
    if (mcp.tokenInput !== undefined) {
      api.registerService({
        id: "filament-onboarding",
        start: async (ctx) => {
          // Resolve the connect token: a raw string, a `${ENV}` shorthand, or a
          // SecretRef pointing at an env/file/exec provider (resolved from the
          // gateway config + snapshot).
          const resolved = await resolveConfiguredSecretInputString({
            config: api.config,
            env: process.env,
            value: mcp.tokenInput,
            path: "plugins.entries.filament-fcm.config.connectToken",
          });
          const token = resolved.value;
          if (!token) {
            ctx.logger.info?.(
              `filament-onboarding: connect token did not resolve${
                resolved.unresolvedRefReason ? ` (${resolved.unresolvedRefReason})` : ""
              }; skipping onboarding`,
            );
            return;
          }
          await runOnboarding({
            mcpUrl: mcp.mcpUrl,
            token,
            log: (message) => ctx.logger.info?.(message),
          });
        },
      });
    }
  },
});
