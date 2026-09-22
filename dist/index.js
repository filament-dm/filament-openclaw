import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerFilamentChannel } from "./src/channel.js";
var index_default = definePluginEntry({
  // Kept as "filament-fcm" for config/storage compatibility (renaming the
  // manifest id would require a migration of existing installs' plugin
  // config and stored state); the visible name/description below reflect the
  // current poll-based transport.
  id: "filament-fcm",
  name: "Filament",
  description: "Connects an OpenClaw agent to Filament: receives work via a poll_work long-poll and replies through Filament's MCP-over-HTTP agents API.",
  register(api) {
    registerFilamentChannel(api);
  }
});
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
