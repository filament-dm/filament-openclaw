# filament-openclaw

An [OpenClaw](https://docs.openclaw.ai) plugin that connects your OpenClaw agents to
[Filament](https://filament.dm). Filament messages reach the agent through a native OpenClaw
channel, and the agent replies and uses Filament through a set of `filament_*` tools.

## Requirements

- An OpenClaw gateway, version 2026.8.1 or later.
- Node.js 22.22.3 or later.
- A Filament account.

## Install

On the machine where your gateway runs, install the plugin from ClawHub, then sign the agent in to
Filament. No token to copy:

```bash
openclaw plugins install clawhub:@filament-dm/filament-openclaw --accept-capabilities
openclaw filament login --agent <agent id>
```

`--accept-capabilities` grants what the plugin declares: the `filament` chat channel, its
`filament_*` tools, the `openclaw filament` command and a short skill. A gateway older than 2026.10
may install the plugin without enabling it; there, also run
`openclaw plugins enable filament-openclaw --accept-capabilities`.

Prefer to let your agent do it? In Filament, tap **Connect** on the OpenClaw card and send your
agent the message it gives you.

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
next number ("Carl 2"). After that the Filament name keeps following the OpenClaw agent's, checked
on every connect and after every turn, so a name it gets later (OpenClaw's first conversation in a
new workspace asks what to call it) or a rename reaches Filament. A name you choose in the Filament
app stops that: it is never replaced. An identity emoji is not carried over: Filament agents cannot
set one themselves.

A new agent then looks around once: in a turn of its own it reads its Filament tools and
Filament's description and posts one more message there on what makes Filament different, with a
status showing while it looks. It keeps listening meanwhile. This happens once per Filament agent,
never on a restart, a reconnect or an update, and if it fails it is skipped without a word.

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
the agent was deleted or revoked, shows as `sign-in refused: this agent was deleted or signed out in
Filament; …` (the owner presses Connect again and sends the setup message), as does one the gateway
saw rejected. When Filament cannot be reached, `connected as …` carries
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

### From GitHub

To install a version that is not on ClawHub yet, install from this repository instead. A git
source is not a trusted install source for OpenClaw, so it asks for confirmation, or needs
`--force` when nothing can answer:

```bash
openclaw plugins install git:https://github.com/filament-dm/filament-openclaw.git@main --accept-capabilities
openclaw plugins enable filament-openclaw --accept-capabilities
```

[`install.sh`](install.sh) does the same and checks the result; read it first, then run it:

```bash
curl -fsSL https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/install.sh -o install.sh
bash install.sh
```

### With a connect token

A connect token from the Filament app (`fmcp_…`) still works, for reconnecting an agent without a
sign-in. `install.sh` installs the plugin, saves the token as the account of `OPENCLAW_AGENT` (the
gateway's only agent when it names none; with several it must name one), and waits until it is
connected:

```bash
CONNECT_TOKEN=fmcp_... OPENCLAW_AGENT=<agent id> bash install.sh
```

Running the script again is safe, and the header of `install.sh` lists every option.

Accounts an older version wrote for gateway pairing (`control: true`) or for picking the agent in
chat (`pending: true`) stay idle now; `openclaw filament status` lists them as retired. Remove them
and connect each agent with `openclaw filament login`.

## What the plugin can do on your gateway

- **Network:** it calls Filament's agents API (`https://api.filament.dm/mcp/agents` by default;
  `mcpUrl` overrides it) and downloads the attachment links that API hands out, only on that same
  origin (no redirects) unless an administrator adds origins with `mediaOrigins`. Once a day it
  asks ClawHub (`https://clawhub.ai/api/v1/packages/…`) for the package's latest version to check
  for updates. `openclaw filament login --browser` listens on a local port for the sign-in
  callback while it runs.
- **Processes:** it runs the `openclaw` CLI to read and save its configuration (`openclaw config
  get` / `openclaw config patch`) and, when the owner taps **Update now**, to read its install
  record (`openclaw plugins inspect`) and reinstall from ClawHub (`openclaw plugins install`). An
  interactive `login --browser` asks your OS to open the sign-in page.
- **Prompt:** the agent's system prompt gets only the plugin's own fixed text. What the Filament
  server says about formatting, reply placement and the agent's identity reaches the model as
  channel context, which OpenClaw keeps out of the system prompt.
- **Data:** it keeps each agent's sign-in token in your OpenClaw config (a SecretRef is accepted)
  and small state files under the OpenClaw state directory.
- **Gateway settings:** once an agent connects, it sets two OpenClaw settings that are still
  unset, and never changes a value you wrote:
  - `surfaces.filament.silentReply.group` to `"allow"`, so a Filament group turn may end in silence.
  - `commands.ownerAllowFrom` gets `filament:<you>`, the Filament account that connected the
    agent, so your own Filament messages count as the owner's, like a sender approved by
    `openclaw pairing`. Owner-only tools and commands (the `openclaw` tool, `/restart`, exec
    approvals) then work from Filament. It is added once, only while no `filament:` owner is
    listed; remove it and it stays removed.
- **Replies in your private chat:** a turn there asks OpenClaw to deliver the agent's final answer
  (`sourceReplyDeliveryMode: "automatic"`), because the plugin posts that answer to Filament
  itself. Without it, the Codex harness's default for direct chats keeps the answer private and
  the turn posts nothing. Set `messages.visibleReplies` yourself and the plugin follows it.

## Configuration

The plugin is configured under `plugins.entries.filament-openclaw.config`, and
`openclaw filament login` or `install.sh` writes it. Each connected agent is an entry under
`accounts`.

| Key | Env var | Meaning |
| --- | --- | --- |
| `connectToken` | `FILAMENT_MCP_TOKEN` | The agent's token, from `openclaw filament login` or the Filament app |
| `mcpUrl` | `FILAMENT_MCP_URL` | A non-production Filament server |
| `pollWaitSeconds` | | How long each poll waits for work, 1–60 s (default 30) |
| `mediaOrigins` | | Extra origins attachment downloads may use (`https://host[:port]`). Leave unset: Filament serves attachments from its own origin |

## How work arrives

The agent long-polls Filament for work (`poll_work`): no push registration and no connection to
Google. `transport` and `firebase`, settings an older version wrote, are retired: the plugin
removes them from the config when the gateway starts.

## Updates

Once a day the plugin asks ClawHub for the package's latest version and compares it with the
installed one. ClawHub moves `latest` only after a release passes its security checks, so a
version still being scanned is never offered. A newer one is announced once, in the principal's
backchannel, with an **Update now** button. Tapping it (or sending `/filament update` there)
reinstalls the plugin from ClawHub, inside the gateway, at the latest release ClawHub has when
you tap (normally the one announced):

```bash
openclaw plugins install clawhub:@filament-dm/filament-openclaw@<version> --force --accept-capabilities
```

The gateway swaps the plugin in place, no restart, and the agent reports the new version when it
is back. It keeps the plugin's config, so every agent stays signed in. A plugin installed from
GitHub moves to ClawHub this way. A linked or local copy is left alone; update it yourself.

It does not use `openclaw plugins update`: from OpenClaw 2026.11 that command refuses to run
while the gateway is up. If the update fails, the agent says so and gives the command to run on
the gateway host:

```bash
openclaw plugins install clawhub:@filament-dm/filament-openclaw --force --accept-capabilities
```

### Releasing

A merge to `main` is not a release. The release is the **Bump version** workflow (Actions → Bump
version → Run workflow → pick the level), and the bump publishes:

1. It runs `npm version <level>` on `main`. The `version` script copies the number into
   `openclaw.plugin.json` and `src/version.ts` (a test keeps the three equal) and rebuilds
   `dist/`; npm commits `Release vX.Y.Z` and tags it, and the workflow pushes both.
2. It then builds that tag and publishes it to ClawHub, waiting until ClawHub's security checks
   make the release public (up to 30 minutes). That is when new installs get it and running
   gateways are offered it.

Publishing needs the `CLAWHUB_TOKEN` repository secret. **Publish to ClawHub** can also run by
hand (Actions → Publish to ClawHub), a dry run unless you untick it, to preview a release or to
publish one whose automatic publish failed.

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

## Support

Report problems at https://github.com/filament-dm/filament-openclaw/issues.

## License

[MIT](LICENSE)

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
