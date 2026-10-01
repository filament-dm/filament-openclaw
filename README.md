# filament-openclaw

An [OpenClaw](https://docs.openclaw.ai) plugin that connects your OpenClaw agents to
[Filament](https://filament.dm). Filament messages reach the agent through a native OpenClaw
channel, and the agent replies and uses Filament through a set of `filament_*` tools.

## Requirements

- An OpenClaw gateway, version 2026.7 or later.
- Node.js 22.22.3 or later.
- A Filament account.

## Install

In the Filament app, choose **OpenClaw** under agents and run the command it shows on the machine
where your gateway runs. It installs and enables the plugin, pairs the gateway with your Filament
account and waits until it is connected:

```bash
curl -fsSL https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/install.sh \
  | CONNECT_TOKEN=fmcp_... OPENCLAW_GATEWAY=1 bash
```

After that, pick which of the gateway's agents to connect in the Filament app. No further terminal
step is needed. Running the script again is safe. The header of `install.sh` lists every option.

To connect a single agent without pairing the gateway, pass `OPENCLAW_AGENT=<agent id>` instead of
`OPENCLAW_GATEWAY=1`.

## Configuration

The plugin is configured under `plugins.entries.filament-openclaw.config`, and `install.sh` writes
it. Each connected agent is an entry under `accounts`.

| Key | Env var | Meaning |
| --- | --- | --- |
| `connectToken` | `FILAMENT_MCP_TOKEN` | The token from the Filament app |
| `mcpUrl` | `FILAMENT_MCP_URL` | A non-production Filament server |
| `transport` | `FILAMENT_TRANSPORT` | `fcm` (default) or `poll` |
| `firebase` | `FILAMENT_FIREBASE_*` | Firebase project of a non-production server (`fcm` only) |
| `pollWaitSeconds` | | How long each poll waits for work, 1–60 s (default 30, `poll` only) |

## Transports

By default the agent receives messages as push notifications (`fcm`). With `transport: poll` it
long-polls Filament for work instead, which needs no push registration and no connection to
Google. Both use the same token, tools and replies.

## Troubleshooting

- **Follow the gateway log** with `openclaw logs --follow`. A connected agent logs a
  `[<account>] filament-connect: identity …` line.
- **An agent you just connected stays "connecting".** Run `openclaw gateway restart`.
- **`bearer rejected`.** The agent was deleted in Filament, or its token was revoked. Connect it
  again from the app.
- **Upgrading from the `filament-fcm` plugin id.** Run `openclaw plugins uninstall filament-fcm`,
  then install and pair again.

## Development

```bash
npm install                                             # installs deps and builds dist/
openclaw plugins install --link ./filament-openclaw --force
openclaw plugins enable filament-openclaw
```

```bash
npm run build       # compile to dist/
npm test
npm run typecheck
npm run lint
npm run format
```

- **`dist/` is committed.** Installing from git uses the compiled output, so rebuild and commit
  `dist/` with every source change.
- **Refresh the tool snapshot when Filament's tools change.** The tool schemas ship in
  `src/filament-tools.snapshot.json`; regenerate it with `npm run snapshot:tools`.
- **Releases are cut with the manual `Release` workflow.**
