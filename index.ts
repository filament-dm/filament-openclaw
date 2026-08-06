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

import { buildSnapshot, createReceiver, resolveFcmConfig } from "./src/fcm.js";
import { registerConformanceRoutes } from "./src/conformance-http.js";

import type { ConnectHandle } from "./src/connect.js";
import { registerFilamentChannel } from "./src/channel.js";

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

    // ── Filament channel: the whole integration ───────────────────────
    // A channel (not a service) so the gateway drives inbound → agent turn →
    // outbound. Its startAccount runs the connect sequence (get_self → accept
    // invites/vouches → FCM register → register_push_token → heartbeat →
    // first-contact greeting), then holds open decoding inbound pushes. See
    // src/channel.ts. `connection` tracks the live handle for the conformance
    // token snapshot below.
    let connection: ConnectHandle | null = null;
    registerFilamentChannel(api, (next) => {
      connection = next;
    });

    // ── Opt-in: conformance control surface (env FILAMENT_CONFORMANCE_ENABLED) ─
    // Off by default. Exposes GET /conformance/manifest and POST /conformance/op
    // on the gateway's HTTP server (gateway bearer auth). Reads the live token
    // snapshot from the connect sequence (or the cached token when connect isn't
    // running), reporting no_cached_token until registration completes.
    if (process.env.FILAMENT_CONFORMANCE_ENABLED) {
      registerConformanceRoutes(api, {
        getTokenSnapshot: () => (connection ? connection.snapshot() : buildSnapshot(false)),
      });
    }
  },
});
