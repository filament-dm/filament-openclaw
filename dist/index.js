import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerFilamentChannel } from "./src/channel.js";
var index_default = definePluginEntry({
  id: "filament-openclaw",
  name: "Filament",
  description: "Connects an OpenClaw agent to Filament: receives work as FCM pushes or through a poll_work long-poll, and replies through Filament's MCP-over-HTTP agents API.",
  register(api) {
    registerFilamentChannel(api);
  }
});
export {
  index_default as default
};
