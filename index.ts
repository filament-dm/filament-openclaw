// Filament plugin entrypoint. Registers the Filament channel — the whole
// integration that connects an OpenClaw agent to Filament: inbound messages
// arrive as FCM pushes or, opt-in, through a `poll_work` long-poll, and the
// agent's replies go back out over Filament's MCP-over-HTTP agents API. The
// channel lives in src/channel.ts.
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
    // The real OpenClawPluginApi.registerTool requires a TypeBox `TSchema`
    // for `parameters`; `typebox` isn't importable from this package (see
    // src/filament-tools.ts's module docstring), so FilamentChannelApi
    // deliberately types `parameters` as `unknown` and this boundary needs
    // an explicit cast rather than relying on structural inference.
    registerFilamentChannel(api as unknown as FilamentChannelApi);
  },
});
