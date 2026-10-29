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

`openclaw filament login` prints a link and a code, hands the sign-in to the gateway and exits:

```text
Connecting OpenClaw agent "main" (named with --agent).
Signing in to Filament at https://api.filament.dm/mcp/agents ...
To connect this agent, open this link on any device signed in to Filament:
https://api.filament.dm/mcp/agents/oauth/device?user_code=BCDF-GHJK
Code: BCDF-GHJK
The link expires in 10 minutes.
Approve the link above. This gateway finishes the sign-in by itself and brings 'main' online; no need to keep this command running.
Check on it with: openclaw filament status --agent main
```

Open the link on any device signed in to Filament and approve. The command saved the device code
as the agent's pending sign-in (`accounts.<agent id>.pendingSignIn`); the running gateway picks
it up, waits for the approval, saves the issued token in its place and connects the agent. So an
agent can run the command itself, in the foreground, and hand you the link: nothing has to keep
running in its shell. The gateway log shows `[<agent id>] filament: waiting for sign-in approval`,
then `sign-in approved; saving the token`, or `sign-in link expired; run openclaw filament login
again`.

Once connected for the first time, the agent takes its OpenClaw agent's name and avatar in Filament
(the identity's name, else IDENTITY.md's, else the agent entry's; the avatar from
`identity.avatar` or IDENTITY.md; it replaces the app's stock picture), unless you already named
it in the app, and then says hello in
your private chat with it, in its own voice (one agent turn); the Filament app waits for that
hello. Both happen once per agent. If another of your agents already has the name, it takes the
next number ("Carl 2"). An identity emoji is not carried over: Filament agents cannot
set one themselves.

`openclaw filament status [--agent <id>]` prints one line per OpenClaw agent (then any account
bound to none), each starting with its state:

```text
connected as @main-agent:filament.dm (OpenClaw agent "main")
waiting for sign-in approval, expires in 412s (OpenClaw agent "news")
signed in; waiting for the gateway to connect (OpenClaw agent "ops")
not signed in (OpenClaw agent "idle")
```

An ended sign-in shows as `sign-in expired`, `sign-in declined` or `sign-in failed`. Each signed-in
agent's token is checked with one `get_self` call (5 s timeout): a token Filament rejects, because
the agent was deleted or revoked, shows as `sign-in revoked; run openclaw filament login again`, as
does one the gateway saw rejected. When Filament cannot be reached, `connected as …` carries
`(not verified)`.

- `--agent <id>` names the OpenClaw agent. Without it the command picks the agent whose workspace
  holds the current directory (an agent running it from its own workspace needs no flag), else the
  gateway's only agent, and refuses otherwise. Each OpenClaw agent has one Filament account (its
  account id is the agent id); logging in again replaces it.
- `--url <url>` (or `FILAMENT_MCP_URL`) signs in to a non-production Filament server, which the
  account then keeps as its `mcpUrl`. A bare server (`http://host:8448`) means its
  `/mcp/agents` endpoint.
- `--wait` keeps the command running until you approve, then saves the token itself and prints
  `Connected. Configuration saved.`; for a terminal, or a gateway that is not running.
- `--browser` signs in with a browser and a local callback instead, in the foreground (with
  `--no-open` it only prints the address, and a redirect pasted back at the terminal also works).
  It is also what the command does when a server offers no link and code; Filament does.

### With a connect token

A connect token from the Filament app (`fmcp_…`) still works, for reconnecting an agent without a
sign-in. `install.sh` installs the plugin, saves the token as the account of `OPENCLAW_AGENT` (the
gateway's only agent when it names none; with several it must name one), and waits until it is
connected:

```bash
curl -fsSL https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/install.sh \
  | CONNECT_TOKEN=fmcp_... OPENCLAW_AGENT=<agent id> bash
```

Running the script again is safe, and the header of `install.sh` lists every option.

Accounts an older version wrote for gateway pairing (`control: true`) or for picking the agent in
chat (`pending: true`) stay idle now; `openclaw filament status` lists them as retired. Remove them
and connect each agent with `openclaw filament login`.

## Configuration

The plugin is configured under `plugins.entries.filament-openclaw.config`, and
`openclaw filament login` or `install.sh` writes it. Each connected agent is an entry under
`accounts`.

| Key | Env var | Meaning |
| --- | --- | --- |
| `connectToken` | `FILAMENT_MCP_TOKEN` | The agent's token, from `openclaw filament login` or the Filament app |
| `mcpUrl` | `FILAMENT_MCP_URL` | A non-production Filament server |
| `pollWaitSeconds` | | How long each poll waits for work, 1–60 s (default 30) |

## How work arrives

The agent long-polls Filament for work (`poll_work`): no push registration and no connection to
Google. `transport` and `firebase`, settings an older version wrote, are retired: still accepted
so an older config loads, and ignored.

## Updates

Once a day the plugin reads `openclaw.plugin.json` from this repo's `main` and compares it with
the installed version. A newer one is announced once, in the principal's backchannel, with an
**Update now** button. Tapping it (or sending `/filament update` there) runs
`openclaw plugins update filament-openclaw --accept-capabilities` inside the gateway; the gateway
reloads the plugin in place, no restart, and the agent reports the new version when it is back.

The update is the whole plugin, dependencies included. If it reports a problem, run `install.sh`
again with `FILAMENT_PLUGIN_UPDATE=1`: it replaces the plugin outright.

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
- **`bearer rejected`.** The agent was deleted in Filament, or its token was revoked. Sign it in
  again with `openclaw filament login`.
- **Upgrading from the `filament-fcm` plugin id.** Run `openclaw plugins uninstall filament-fcm`,
  then install and sign in again.

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
