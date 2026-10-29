import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerFilamentChannel } from "./src/channel.js";
import { registerFilamentCli } from "./src/login-cli.js";
var index_default = definePluginEntry({
  id: "filament-openclaw",
  name: "Filament",
  description: "Connects an OpenClaw agent to Filament: receives work through the poll_work long-poll and replies through Filament's MCP-over-HTTP agents API.",
  register(api) {
    const mode = api.registrationMode;
    if (mode === "cli-metadata" || mode === "discovery" || mode === "full" || mode === void 0) {
      registerFilamentCli(api);
      if (mode === "cli-metadata") return;
    }
    registerFilamentChannel(api);
  }
});
export {
  index_default as default
};
