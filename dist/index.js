import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildSnapshot } from "./src/fcm.js";
import { registerConformanceRoutes } from "./src/conformance-http.js";
import { registerFilamentChannel } from "./src/channel.js";
var index_default = definePluginEntry({
  id: "filament-fcm",
  name: "Filament (FCM)",
  description: "Connects an OpenClaw agent to Filament: receives messages as Firebase Cloud Messaging (FCM) pushes and replies through Filament's MCP-over-HTTP agents API.",
  register(api) {
    let connection = null;
    registerFilamentChannel(api, (next) => {
      connection = next;
    });
    if (process.env.FILAMENT_CONFORMANCE_ENABLED) {
      registerConformanceRoutes(api, {
        getTokenSnapshot: () => connection ? connection.snapshot() : buildSnapshot(false)
      });
    }
  }
});
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
