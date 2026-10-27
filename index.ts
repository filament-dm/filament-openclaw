import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { registerFilamentChannel, type FilamentChannelApi } from "./src/channel.js";
import { registerFilamentCli, type FilamentCliApi } from "./src/login-cli.js";

export default definePluginEntry({
  id: "filament-openclaw",
  name: "Filament",
  description:
    "Connects an OpenClaw agent to Filament: receives work as FCM pushes or " +
    "through a poll_work long-poll, and replies through Filament's " +
    "MCP-over-HTTP agents API.",
  register(api) {
    const mode = api.registrationMode;
    if (mode === "cli-metadata" || mode === "discovery" || mode === "full" || mode === undefined) {
      // Commander's types ship with OpenClaw, not this package; FilamentCliApi is structural.
      registerFilamentCli(api as unknown as FilamentCliApi);
      if (mode === "cli-metadata") return;
    }
    // OpenClaw's registerTool wants a TypeBox schema, which this package can't import, so
    // FilamentChannelApi types tool parameters as `unknown` and needs a cast here.
    registerFilamentChannel(api as unknown as FilamentChannelApi);
  },
});
