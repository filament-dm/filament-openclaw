import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { registerFilamentChannel, type FilamentChannelApi } from "./src/channel.js";

export default definePluginEntry({
  id: "filament-openclaw",
  name: "Filament",
  description:
    "Connects an OpenClaw agent to Filament: receives work as FCM pushes or " +
    "through a poll_work long-poll, and replies through Filament's " +
    "MCP-over-HTTP agents API.",
  register(api) {
    // OpenClaw's registerTool wants a TypeBox schema, which this package can't import, so
    // FilamentChannelApi types tool parameters as `unknown` and needs a cast here.
    registerFilamentChannel(api as unknown as FilamentChannelApi);
  },
});
