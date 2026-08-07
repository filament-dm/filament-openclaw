// Filament plugin entrypoint. Registers the Filament channel — the whole
// integration that connects an OpenClaw agent to Filament: inbound messages
// arrive as Firebase Cloud Messaging (FCM) pushes and are dispatched to the
// agent, and the agent's replies go back out over Filament's MCP-over-HTTP
// agents API. The channel lives in src/channel.ts; an opt-in conformance
// surface (below) exposes the FCM token snapshot for parity testing.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { buildSnapshot } from "./src/fcm.js";
import { registerConformanceRoutes } from "./src/conformance-http.js";

import type { ConnectHandle } from "./src/connect.js";
import { registerFilamentChannel } from "./src/channel.js";

export default definePluginEntry({
  id: "filament-fcm",
  name: "Filament (FCM)",
  description:
    "Connects an OpenClaw agent to Filament: receives messages as Firebase " +
    "Cloud Messaging (FCM) pushes and replies through Filament's MCP-over-HTTP " +
    "agents API.",
  register(api) {
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
