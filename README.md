# filament-openclaw

An [OpenClaw](https://docs.openclaw.ai) plugin that connects an agent to [Filament](https://filament.dm). It is the TypeScript counterpart to the Python [`filament-hermes`](https://github.com/filament-dm/filament-hermes) plugin.

## Architecture

Same shape as the Hermes plugin — **no Matrix client or Matrix token is involved**. We do not use OpenClaw's Matrix channel plugin.

Work reaches each account over one of two **transports**, chosen by `transport`
(top level for every account, or per account):

| | `fcm` — **default** | `poll` — opt-in |
|---|---|---|
| Server needed | any Filament (production, develop) | a synapse carrying ENG-1392 (`poll_work`) and ENG-893 (token exchange) |
| Inbound | Firebase Cloud Messaging pushes (DirectPusher), one per message | a blocking `poll_work` call returning work items |
| Credential | the connect token is the bearer | the connect token is exchanged once for a bearer |
| What wakes the agent | the plugin decides (`src/transports/fcm/wake-policy.ts`, a port of Hermes' policy) | the server decides |
| Where the reply goes | the plugin decides (`reply-route.ts`, per the participation rules) | the server's `reply_with` |
| One reply per message | the turn records a reply a tool already sent | the server's work ledger |

Both transports share everything else (`src/`): connecting and presence
(`connect.ts`), the agent turn (`turn.ts`), the `filament_*` tools
(`filament-tools.ts`) and the gateway control account (`gateway.ts`). Each lives
in `src/transports/<name>/` and neither imports the other; `src/channel.ts`
picks one per account. Outbound always goes through Filament's **MCP-over-HTTP
agents API**, with a bearer token (not a Matrix access token).

The plugin id (`filament-fcm`) and manifest are unchanged for config/storage
compatibility — renaming either would need a migration for existing installs.

## OpenClaw channels

In OpenClaw, a **channel** is a messaging integration that connects a conversation surface to the agent. The bundled channels are things like `discord`, `slack`, `telegram`, `whatsapp`, `imessage`, `signal`, and `matrix`. A channel owns both directions of the loop: it delivers an **inbound** message to the gateway, which wakes an agent turn, and the gateway routes the agent's **outbound** reply *back to the channel it came from* (routing is deterministic and host-controlled — the model does not pick a channel).

- Overview of the built-in channels: <https://docs.openclaw.ai/channels>
- How inbound messages route to a turn and replies route back: <https://docs.openclaw.ai/channels/channel-routing>
- Writing your own channel as a plugin (the SDK contract): <https://docs.openclaw.ai/plugins/sdk-channel-plugins>

This is the mechanism this plugin uses — **but not by adopting a built-in channel.** We deliberately do **not** use OpenClaw's Matrix channel (no Matrix client or Matrix token is involved). Instead, Filament becomes its *own* custom channel: **inbound** work arrives as FCM pushes or through a `poll_work` long-poll (not a Matrix sync — see "Architecture" above), and **outbound** replies are sent over Filament's MCP-over-HTTP agents API. Registering as a channel is also the only way a third-party plugin can wake an agent turn on an inbound message — see the next section.

## Plugin trust and the OpenClaw origin gate

Waking the agent on an inbound message runs into an OpenClaw trust boundary, and it dictates the shape of this plugin. Findings verified against the gateway we target (`2026.7.1-2`, commit `0790d9f`).

OpenClaw classifies every plugin by a **`PluginOrigin`**: `bundled | global | workspace | config`. `bundled` is reserved for plugins shipped *inside* the OpenClaw package itself. **A plugin installed from git or npm is never `bundled`** — it is `global`/`config` — and **no amount of user trust changes that.** "Trusting" a plugin is a *separate* axis (`explicitlyEnabled`), granted by either:

- `plugins.entries.<id>.enabled = true` (what `openclaw plugins enable <id>` writes), or
- listing the id in `plugins.allow`.

Trust gates *whether a plugin may load and register*; **origin** gates *which runtime capabilities it may use*. The distinction is what forces our design:

| Capability | Gate | Available to us (git-installed, trusted)? |
| --- | --- | --- |
| `session.workflow.scheduleSessionTurn` — **wake a new agent turn** | `origin === "bundled"` only | ❌ **No.** Bundled-only; returns `undefined` for us. |
| `session.workflow.enqueueNextTurnInjection` — add context to the *next* turn | none | ✅ Yes — but it only decorates a turn that something else starts; it can't wake one. |
| `registerChannel` — a full inbound→turn→outbound message transport | not origin-gated (only rejects a *disabled workspace* plugin) | ✅ **Yes**, when the plugin is enabled/trusted. |
| `registerTool` / `registerService` / `registerHttpRoute` / `registerHook` / `registerGatewayMethod` | none (hooks need `opts.name`) | ✅ Yes. |

**Conclusion — the implementation must be an OpenClaw channel plugin.** The lightweight "background service wakes a turn with `scheduleSessionTurn`" path is a dead end for a third-party plugin (bundled-only). The only turn-waking path open to us is `api.registerChannel(...)`: we register Filament as a native messaging channel, and the gateway drives the loop — a push or a `poll_work` item becomes a channel message that wakes an agent turn, and the agent's reply comes back to our channel adapter, which posts it to Filament over MCP. This is also the closest analog to how the Python `filament-hermes` plugin subclasses a gateway platform adapter. (See `ROADMAP.md` for the SDK checkpoint that pinned the exact contract this relies on.)

### Required trust step after install

Because channel registration requires the plugin to be **enabled/trusted**, installation is not complete until you enable it (this is also what silences the gateway's `plugins.allow is empty … non-bundled plugins may auto-load` warning):

```bash
openclaw plugins enable filament-fcm          # sets plugins.entries.filament-fcm.enabled = true
# equivalently / additionally, add it to the trust allow-list:
openclaw config set plugins.allow '["filament-fcm"]'
```

## Current Progress

A PoC with two transports (see "Architecture"); unit-tested and exercised offline
(`scripts/gateway-e2e.mjs` for poll, `src/transports/fcm/index.test.ts` for FCM). The plugin
registers a Filament **channel** whose `startAccount` runs the whole integration:

- **Settings** (`src/settings.ts`) — per account: token, `mcpUrl`, `transport`, `firebase`,
  `pollWaitSeconds`, each layered over the top-level value.
- **Connect** (`src/connect.ts`, `src/credentials.ts`) — the bearer (the connect token itself
  for `fcm`; a one-time, persisted exchange for `poll`), then `initialize` + `get_self` to learn
  the agent's identity, and a 20s heartbeat for presence.
- **FCM transport** (`src/transports/fcm/`) — restored from the original FCM plugin: accept
  pending invites/vouches, register with Firebase, `register_push_token`, greet on first
  contact. Each push is decoded; pings get a `/pong`, invites and vouches are accepted, and a
  chat message that passes the wake policy runs one turn, whose reply is posted once where
  participation allows (a thread off the message in a channel). A failed turn is logged and
  dropped rather than pausing the account.
- **Poll transport** (`src/transports/poll/`) — a sequential, cancelable `poll_work` long-poll:
  one turn per item, published at most once via `reply_with`. Backoff on transient failures;
  an auth failure or a failed publish pauses the account.
- **Turn** (`src/turn.ts`) — one turn per work item, session isolated per
  account/channel/thread; only `final` dispatcher text is collected. `commandAuthorized` is
  only ever true for the backchannel.
- **Tools** (`src/filament-tools.ts`) — the Filament MCP tool surface, minus `poll_work` and the
  two push-token tools, registered as `filament_`-prefixed OpenClaw tools from a reviewed
  snapshot. See "Tools exposed to the agent" below.

See [`ROADMAP.md`](ROADMAP.md) for status and what's next.

## Requirements

- OpenClaw `>= 2026.7.0` (the gateway provides the `openclaw` peer dependency)
- Node `>= 22.22.3`

## Install (from this private git repository)

**One-line install** (what the Filament app's "Connect your OpenClaw agent"
dialog shows; the token is the single-use `fmcp_…` connect token, exchanged
once by the plugin for a persistent bearer):

```bash
curl -fsSL https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/install.sh | CONNECT_TOKEN=fmcp_... OPENCLAW_AGENT=researcher bash
```

Run it once per Filament agent; it is idempotent. `install.sh` checks for
`openclaw` and a running gateway, installs the plugin from git only if the
gateway lacks it (`PLUGIN_REF` selects a branch, default `main`;
`FILAMENT_PLUGIN_UPDATE=1` updates an existing install), creates the OpenClaw
agent `OPENCLAW_AGENT` if it doesn't exist, and writes — in one validated
`openclaw config patch` — the token as the channel account of the same id plus
the binding that routes it to that agent. It then waits for that account's
connect log line. `OPENCLAW_PLUGIN_SOURCE` overrides the install spec for a
future ClawHub package. Without `OPENCLAW_AGENT` it keeps the single-agent
shape (the `default` account).

### Pairing the gateway (what the Filament app does now)

The OpenClaw card in the Filament app shows one command, run once per gateway:

```bash
curl -fsSL …/install.sh | CONNECT_TOKEN=fmcp_... OPENCLAW_GATEWAY=1 bash
```

It installs the plugin if missing and connects the token as a **gateway
control account** (`accounts.gateway`, `control: true`). That account runs no
agent turns and never writes into the chat (the Filament app hides it and its
backchannel). It reports the gateway's OpenClaw agents to Filament over the
tool-inventory side channel (`POST /mcp/agents/tools`), and it obeys commands
from its principal in its own backchannel:

- `/filament connect <agent-id> <fmcp_token> [<request-id>]`
- `/filament disconnect <agent-id> [<request-id>]`
- `/filament unpair [<request-id>]`
- `/filament agents`

Each command is consumed with a read receipt, applied as one
`api.runtime.config.mutateConfigFile` write per poll, and its outcome is
reported as an inventory entry (`origin: "openclaw-gateway-status"`, keyed by
the request id) that the app's connect popup reads. See `src/gateway.ts`.

Trade-off, accepted for the PoC: the connect token for each agent travels as a
chat message, so it stays in that room's history — single-use, and revoked by
the server the moment the new account exchanges it.

### Several Filament agents on one gateway

Each Filament agent is one **channel account**, and each account is bound to
its own OpenClaw agent:

```json5
plugins: { entries: { "filament-fcm": { config: {
  mcpUrl: "…/mcp/agents",                       // shared by every account
  accounts: {
    researcher: { connectToken: "fmcp_…" },
    writer:     { connectToken: "fmcp_…" },
  },
} } } },
bindings: [
  { agentId: "researcher", match: { channel: "filament", accountId: "researcher" } },
  { agentId: "writer",     match: { channel: "filament", accountId: "writer" } },
],
```

Every account runs its own transport and bearer. The `filament_*` tools are
registered as factories, so each OpenClaw agent's tools call Filament as *its*
account (found through its binding), and an agent with no Filament account gets
none. The legacy top-level `connectToken` is still read, as the `default`
account.

This plugin is **not published to ClawHub or npm**. Install it straight from git.
OpenClaw's `git:` installer (verified against 2026.7.1-2) accepts `@<ref>` or
`#<ref>`, where the ref is a branch, tag or commit. It clones to a temporary
directory, checks out the ref, runs the normal directory installer (manifest
validation, the operator's plugin install policy, `npm install` of runtime
dependencies only) and records URL + ref + resolved commit in the plugin index.

```bash
# Default branch
openclaw plugins install git:git@github.com:filament-dm/filament-openclaw.git

# A branch, tag or commit under test
openclaw plugins install git:git@github.com:filament-dm/filament-openclaw.git@pablo/eng-1392-poll-work-channel
```

Rules of the installer that matter here:

- The repo is public: the HTTPS form needs no credentials; `git@github.com:`
  works too if the host has a key.
- `dist/` must be committed on the ref you install (see below). A branch whose
  `dist/` is stale or missing fails with the "compiled runtime output" error.
- `--force` is only needed when the id `filament-fcm` is already installed and
  you are switching source or ref; a first install does not need it.
  `--force` cannot be combined with `--link`.
- `--pin` is npm-only. For `git:` the ref in the spec is the pin.
- To pick up a new commit on the same branch: push, then
  `openclaw plugins update filament-fcm` re-resolves the recorded ref. To change
  branch, reinstall with `--force` and the new spec.

Then enable it and restart the gateway so the new code loads (managed gateways auto-restart):

```bash
openclaw plugins enable filament-fcm
openclaw plugins list --enabled
```

Verify it loaded by checking the gateway log for `filament: registered channel 'filament'` and the `filament-connect:` startup lines (bearer resolved/exchanged, identity resolved), then `filament: transport fcm` (or `poll`), and `filament-fcm: push token registered` (or `filament-poll:` lines) once the transport is up.

> Replace the repository URL above if you host this somewhere other than
> `github.com/filament-dm/filament-openclaw`.

## Local development

If you want to immediately evaluate your changes while editing the package, link the checkout into OpenClaw:

```bash
npm install # installs deps and builds dist/ (via the prepare script)
openclaw plugins install --link ./filament-openclaw --force
openclaw plugins enable filament-fcm
```

Scripts:

```bash
npm run build        # transpile index.ts + src/*.ts -> dist/ (esbuild)
npm run typecheck    # tsc --noEmit
npm run format       # oxfmt (write in place)
npm run lint         # oxlint
```

Formatting and linting also run as pre-commit hooks via [prek](https://github.com/j178/prek) (`prek install` to enable); CI runs the same hooks — see `.github/workflows/pre-commit.yml`.

## Build

The plugin is TypeScript, compiled to ESM JavaScript with esbuild. `npm run build` transpiles `index.ts` and the `src/*.ts` modules (the full list is in the `build` script) into `dist/` (runtime deps left external); the `prepare` script runs it automatically on `npm install` / `npm ci`, so `dist/` points at `./dist/index.js` (see `package.json`'s `openclaw.extensions`).

`dist/` **is committed** to this repo. OpenClaw's `git:` / npm plugin installer expects compiled output at `./dist/index.js` and neither installs `devDependencies` nor runs a build step — so the compiled JS must already be in the repo for `git:` installs to work:

``` bash
jstrickland@lima-openclaw-sandbox:~$ openclaw plugins install git:git@github.com:filament-dm/filament-openclaw.git --force && openclaw plugins enable filament-fcm && openclaw plugins list --enabled
│
◇

OpenClaw 2026.7.1-2 (0790d9f)
It's not "failing," it's "discovering new ways to configure the same thing wrong."

Cloning git@github.com:filament-dm/filament-openclaw...
Installing plugin dependencies with npm…
Plugin manifest id "filament-fcm" differs from npm package name "@filament/openclaw-filament-fcm"; using manifest id as the config key.
package install requires compiled runtime output for TypeScript entry ./index.ts: expected ./dist/index.js, ./dist/index.mjs, ./dist/index.cjs, ./index.js, ./index.mjs, ./index.cjs. This is a plugin packaging issue, not a local config problem; update or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then. TypeScript source fallback is only supported for source checkouts and local development paths.
```

Rebuild and re-commit `dist/` whenever you change the source.

In the future, we'll either publish packages to npm or ClawHub, once our plugin stabilizes. At that point, we'll likely add `dist/` to `.gitignore`.

## Releases

Releases are cut by the manually-triggered [`release` workflow](.github/workflows/release.yml). It builds a chosen commit hermetically (pinned Node via `.nvmrc`, `npm ci`, `npm run build`), packs a private tarball, and — when given a tag — creates a GitHub Release with that tarball attached. It does **not** publish to npm or ClawHub yet (those steps are stubbed).

Trigger it from the command line with [`gh`](https://cli.github.com) (the workflow must already be on the default branch):

```bash
# Build the tip of main and cut a tagged, private pre-release:
gh workflow run release.yml --ref main -f tag=v0.1.0

# Artifact only, no Release (builds whatever --ref points at):
gh workflow run release.yml --ref main

# Reproduce a release from a specific commit or tag:
gh workflow run release.yml -f ref=<sha-or-tag> -f tag=v0.1.0 -f prerelease=false
```

`--ref` (`gh` CLI) chooses which commit the workflow file is read from (and the default build ref); `-f ref=` (`release.yml` variable) overrides just the commit that gets built. Watch the run and fetch the artifact:

```bash
gh run list --workflow=release.yml   # find the run id
gh run watch <run-id>                # follow it to completion
gh run download <run-id>             # download the .tgz artifact
# ...or, if you created a tag, grab the Release asset instead:
gh release download v0.1.0 --pattern '*.tgz'
```

To test the tarball locally without publishing to NPM or ClawHub:

```bash
openclaw plugins install npm-pack:./filament-openclaw-filament-fcm-0.1.0.tgz --force
```

## Configuration

| Config key / env var                              | Meaning                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| `connectToken` (config) / `FILAMENT_MCP_TOKEN` (env) | The connect token (`fmcp_…`). `fcm` uses it as the bearer; `poll` exchanges it once and persists the bearer. |
| `mcpUrl` (config) / `FILAMENT_MCP_URL` (env)         | Filament's `/mcp/agents` endpoint (defaults to production; set for staging/local). |
| `transport` (config) / `FILAMENT_TRANSPORT` (env)    | `fcm` (default) or `poll`. install.sh writes it from `FILAMENT_TRANSPORT`. |
| `firebase` (config) / `FILAMENT_FIREBASE_*` (env)    | `{projectId, apiKey, appId, messagingSenderId}` of the Firebase project the homeserver sends through; each field defaults to the env var, then production. Only `fcm` reads it. |
| `pollWaitSeconds` (config)                           | How long (seconds) each `poll_work` long-poll blocks server-side waiting for work. Default **30**, clamped to `[1, 60]`. 30 matches the server's own default and stays clear of ~60s intermediary timeouts (e.g. the `filament-dev.local` nginx dev proxy), which would otherwise race the server's own wait and surface as a spurious `HTTP 504`. Only `poll` reads it. |

A local cluster sends FCM through the dev Firebase project, not production: take its
`project_id`, `api_key`, `app_id` and `sender_id` from the `hosting.*.firebase` block of the
inflated `homeserver.yaml` and pass them as `FILAMENT_FIREBASE_*` to install.sh (or set
`firebase` in the plugin config). With production's project the token registers fine and is
never delivered to.

## Tools exposed to the agent

`src/filament-tools.ts` registers Filament's MCP tool surface as OpenClaw agent tools,
name-prefixed `filament_` (e.g. `filament_post_message`) — in parity with how the Python
`filament-hermes` plugin exposes the same MCP server's tools to its agent, but not with its
mechanism: schemas are **snapshotted from the server** (`src/filament-tools.snapshot.json`, via
`npm run snapshot:tools`) and **registered synchronously at plugin load** (`register(api)`),
rather than fetched live over `tools/list` after connect. This matters because a session's
toolset can be resolved before a *late* registration (the old approach: fetch `tools/list` after
`runConnect`, then call `api.registerTool()` from inside `startAccount`) ever lands in the
registry — see `plans/openclaw/tools-not-visible-diagnosis.md` for the live-gateway log that
caught this. Registering at load removes the race: every `filament_*` tool exists in the
registry before any session can resolve its toolset. After connect, `tools/list` is still called
once, but only to **log drift** (`filament-tools: server exposes N tool(s) not in the snapshot…`
/ `snapshot has M tool(s) the server no longer serves…`) — never to register anything at
runtime any more. Real drift needs a human to re-run `npm run snapshot:tools` and review the
diff. This is on top of, and separate from, the transport's own publish of the turn's final
text (see "Architecture" and "Interaction with the transport's own publish" below).

**Excluded:** `poll_work` (the poll transport owns it exclusively — the agent must never call it)
and `register_push_token`/`list_push_tokens` (transport plumbing: the FCM transport registers its
own token, and Filament keeps one per agent, so an agent registering another would steal its
pushes). Everything else in the reviewed snapshot —
**including** `post_message`, `reply_in_thread`, `message_principal`, `accept_invite`,
`accept_vouch` — is registered (`TOOL_SNAPSHOT`/`KNOWN_TOOL_NAMES` in `src/filament-tools.ts`,
mirrored in `openclaw.plugin.json`'s `contracts.tools` — a unit test asserts the two stay equal)
so a brand-new server-side tool doesn't reach the model without a review pass (regenerating the
snapshot and updating the manifest).

> **Operator note (hypothesis, not yet confirmed live):** after upgrading this plugin, a
> gateway/agent session that already resolved its toolset before the upgrade may need a full
> `openclaw gateway restart` to see a tool-surface change — a plugin **reload** alone may not be
> enough, since the diagnosis above shows toolset resolution is a per-session snapshot taken
> early, not something a later write to the registry retroactively reaches. Flag if a live
> gateway shows a reload *is* sufficient after this change.

**Authorization** (checked inside each tool's `execute()`, since OpenClaw's `registerTool` has no
channel/session-scoping option — see the module docstring in `src/filament-tools.ts` for the full
reasoning and its documented limitation):

| Tier | Rule | Tools |
| --- | --- | --- |
| **Read** | Always allowed, any turn. | Every tool whose live schema sets `annotations.readOnlyHint: true` — `list_channels`, `list_loop_channels`, `get_channel_details`, `get_recent_messages`, `search_messages`, `get_thread`, `get_user_profile`, `search_members`, `list_mentions`, `list_reactions`, `list_pending_invites`, `list_vouches`, `get_self`, `get_backchannel`. |
| **Ring 0** (principal-only) | Allowed only during a turn dispatched from the backchannel (`item.is_backchannel === true`). | `set_profile` — Filament's own tool declares this `agent self-configuration, not channel content` (synapse `tools_config.py`), matching `filament-hermes/docs/agent-boundaries.md` §5's "tools that change the agent are Ring 0 and principal-only". A tool whose `readOnlyHint` is missing or malformed also falls here (fail closed). |
| **Write** | Allowed during any turn this plugin's own transport dispatched (backchannel or group) — denied if called with no active Filament turn at all (e.g. from a different channel's turn). | Everything else: `post_message`, `message_principal`, `reply_in_thread`, `react`, `unreact`, `mark_read`, `set_status`, `accept_invite`, `accept_vouch`, `join_channel`, `leave_channel`, `create_channel`, `rechat`, `quote`, `set_channel_notification_level`. |

A denied or failed call throws (OpenClaw's own tool convention — "throw on failure instead of
encoding errors in content", per its SDK types); calls are logged as
`filament-tools: filament_<name> ok|denied|failed`, without request/response bodies.

### Interaction with the transport's own publish

Both transports post a turn's final text once, after the turn finishes. If the model already
answered itself via a tool call (`filament_post_message`/`filament_reply_in_thread`/
`filament_message_principal`) during the turn:

- **poll:** Filament's work ledger rejects the transport's own publish as a duplicate
  (`work_ledger.AlreadyAnswered`, surfaced as `{"error": "You have already answered this
  message…"}` — HTTP 200, no `isError`). `src/transports/poll/index.ts` recognizes that message
  and treats the item as `published` rather than as a publish failure.
- **fcm:** there is no ledger, so the turn itself records where its write tools replied
  (`endFilamentTurn` in `src/filament-tools.ts`), and the transport skips its own post when that
  conversation was already answered (`filament-fcm: a tool already replied to …`).

## Local setup and limitations

This PoC needs a live Filament gateway to exercise end to end; nothing here starts one. Known
limitations (see `ROADMAP.md` for the full detail and the acceptance criteria this maps to):

- **FCM: the wake policy is the plugin's.** It is the minimum of Hermes' (backchannel, DMs,
  mentions, replies to the agent, follow-ups in an engaged thread; agents never wake each other
  without a mention). Engaged threads are kept in memory, so a restart forgets them.
- **FCM: a failed turn is dropped.** With no ledger to redeliver it, the transport logs it and
  moves on instead of pausing the account.
- **FCM: the Firebase project must match the homeserver's.** See "Configuration".
- **poll: `poll_work` itself carries no invites/vouches.** It only ever returns `m.room.message`
  work, so a poll account joins loops only through `filament_accept_invite` /
  `filament_accept_vouch`, which the agent calls itself. The FCM transport accepts them as they
  arrive, as the original plugin did.
- **poll: the reachability probe may report `push_path_silent`.** Filament's probe pings over
  FCM; a poll account has no FCM registration to answer it.
- **poll: publish recovery is not durable.** A publish that fails or returns an ambiguous result
  pauses the account with a diagnostic rather than guessing whether the reply went through;
  there is no cross-restart/cross-worker exactly-once guarantee (the server-side work ledger is
  per-process and expires after 10 minutes).
