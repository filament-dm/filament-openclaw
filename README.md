# filament-openclaw

An [OpenClaw](https://docs.openclaw.ai) plugin that connects your OpenClaw agents to
[Filament](https://filament.dm). Filament messages reach the agent through a native OpenClaw
channel, and the agent replies and uses Filament through a set of `filament_*` tools.

## Requirements

- An OpenClaw gateway, version 2026.7 or later.
- Node.js 22.22.3 or later.
- A Filament account.

## Install

On the machine where your gateway runs, install and enable the plugin, then sign the agent in to
Filament. No token to copy:

```bash
curl -fsSL https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/install.sh | bash
openclaw filament login --agent <agent id>
```

`openclaw filament login` prints a link and a code:

```text
Signing in OpenClaw agent 'main' to Filament at https://api.filament.dm/mcp/agents ...
To connect this agent, open this link on any device signed in to Filament:
https://api.filament.dm/mcp/agents/oauth/device?user_code=BCDF-GHJK
Code: BCDF-GHJK
Waiting for approval ...
Signed in. Saving the configuration ...
Connected. Configuration saved.
The gateway reloads the Filament plugin and brings 'main' online; follow along with: openclaw logs --follow
```

Open the link on any device signed in to Filament and approve. The command saves the issued
token as that agent's Filament account and exits; the running gateway reloads the plugin and the
agent comes online. An agent can run the command itself, in the background, and hand you the link.

- `--agent <id>` names the OpenClaw agent. Without it the command uses the gateway's only agent,
  and refuses when there are several. Each OpenClaw agent has one Filament account (its account id
  is the agent id); logging in again replaces it.
- `--url <mcp url>` (or `FILAMENT_MCP_URL`) signs in to a non-production Filament server, which the
  account then keeps as its `mcpUrl`.
- `--device` asks for the link and code even if the server could do a browser sign-in; `--browser`
  uses a browser with a local callback instead (with `--no-open` it only prints the address, and a
  redirect pasted back at the terminal also works). By default the command takes the link and code
  when the server offers them, which Filament does.

### With a connect token

The Filament app can also show a command with a connect token. It installs the plugin, connects
that Filament agent and waits until it is connected:

```bash
curl -fsSL https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/install.sh \
  | CONNECT_TOKEN=fmcp_... bash
```

The command names no OpenClaw agent. If the gateway has one, the plugin binds it. If it has
several, the new Filament agent asks in its chat which one should answer as it, with one button per
agent. Connect each Filament agent the same way. Running the script again is safe, and the header
of `install.sh` lists every option.

To bind an agent from the terminal instead, pass `OPENCLAW_AGENT=<agent id>`.

Once one Filament agent is connected, the next ones need no terminal: the app posts
`/filament connect <token>` in that agent's chat, the plugin adds the account to the gateway, and
the new agent asks in its own chat which OpenClaw agent should answer as it.

## Configuration

The plugin is configured under `plugins.entries.filament-openclaw.config`, and
`openclaw filament login` or `install.sh` writes it. Each connected agent is an entry under
`accounts`.

| Key | Env var | Meaning |
| --- | --- | --- |
| `connectToken` | `FILAMENT_MCP_TOKEN` | The agent's token, from `openclaw filament login` or the Filament app |
| `mcpUrl` | `FILAMENT_MCP_URL` | A non-production Filament server |
| `transport` | `FILAMENT_TRANSPORT` | `poll` (default) or `fcm` |
| `firebase` | `FILAMENT_FIREBASE_*` | Firebase project of a non-production server (`fcm` only) |
| `pollWaitSeconds` | | How long each poll waits for work, 1–60 s (default 30, `poll` only) |

## Transports

By default the agent long-polls Filament for work (`poll`), which needs no push registration and
no connection to Google. With `transport: fcm` it receives messages as push notifications instead,
registered with the Firebase project the server names. Both use the same token, tools and replies.

## Updates

Once a day the plugin reads `openclaw.plugin.json` from this repo's `main` and compares it with
the installed version. A newer one is announced once, in the principal's backchannel, with an
**Update now** button. Tapping it (or sending `/filament update` there) runs
`openclaw plugins update filament-openclaw --accept-capabilities` inside the gateway; the gateway
reloads the plugin in place, no restart, and the agent reports the new version when it is back.

The update is the whole plugin, dependencies included. If it reports a problem, run the connect
command from the Filament app again: it replaces the plugin outright.

### Releasing

`npm version <patch|minor|major>` is the release: its `version` script copies the number
into `openclaw.plugin.json` and `src/version.ts` (a test keeps the three equal), rebuilds `dist/`,
and npm commits `Release vX.Y.Z` and tags it. The **Bump version** workflow (Actions → Bump
version → Run workflow → pick the level) does exactly that on `main` and pushes. A merge to `main` is already what
gateways install; the bump is what tells running ones about it.

## Troubleshooting

- **Follow the gateway log** with `openclaw logs --follow`. A connected agent logs a
  `[<account>] filament-connect: identity …` line.
- **An agent you just connected stays "connecting".** Run `openclaw gateway restart`.
- **`Plugin activation or recovery failed` in the gateway log, and the agent is gone.** Run
  `openclaw plugins reload filament-openclaw`; no restart needed.
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
