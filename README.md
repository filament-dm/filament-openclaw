# filament-openclaw

An [OpenClaw](https://docs.openclaw.ai) plugin that connects an agent to [Filament](https://filament.dm). It is the TypeScript counterpart to the Python [`filament-hermes`](https://github.com/filament-dm/filament-hermes) plugin.

## Architecture

Same shape as the Hermes plugin — **no Matrix client or Matrix token is involved**. We do not use OpenClaw's Matrix channel plugin.

- **Inbound (receive):** the plugin long-polls Filament's `poll_work` MCP tool
  (`{cursor, ack, wait_seconds, max_items}`), which blocks server-side until
  there is work or the wait elapses. Each result item is already grouped by
  `(channel_id, thread_id)`, carries every unread `messages[]` for that spot,
  and pre-resolves the reply destination in `reply_with` — there is no push
  socket and no separate decode step.
- **Outbound (send/act):** replies go through Filament's **MCP-over-HTTP agents
  API**, authenticated with a **bearer token** (not a Matrix access token). The
  poll loop itself attempts exactly one `reply_with` publish per item, using
  `reply_with.tool` (`post_message` or `reply_in_thread`) with `reply_with.args`
  verbatim. The agent can also act directly through the registered Filament
  tools mid-turn (see "Tools exposed to the agent" below) — including posting
  its own reply, in which case the loop's publish is recognized as a duplicate
  and skipped rather than treated as a failure.

Earlier revisions of this plugin used Firebase Cloud Messaging (FCM) as the
inbound transport; that has been replaced by `poll_work` (see "Current
progress" and `ROADMAP.md` for the migration and its tradeoffs). The plugin id
(`filament-fcm`) and manifest are unchanged for config/storage compatibility —
renaming either would need a migration for existing installs.

## OpenClaw channels

In OpenClaw, a **channel** is a messaging integration that connects a conversation surface to the agent. The bundled channels are things like `discord`, `slack`, `telegram`, `whatsapp`, `imessage`, `signal`, and `matrix`. A channel owns both directions of the loop: it delivers an **inbound** message to the gateway, which wakes an agent turn, and the gateway routes the agent's **outbound** reply *back to the channel it came from* (routing is deterministic and host-controlled — the model does not pick a channel).

- Overview of the built-in channels: <https://docs.openclaw.ai/channels>
- How inbound messages route to a turn and replies route back: <https://docs.openclaw.ai/channels/channel-routing>
- Writing your own channel as a plugin (the SDK contract): <https://docs.openclaw.ai/plugins/sdk-channel-plugins>

This is the mechanism this plugin uses — **but not by adopting a built-in channel.** We deliberately do **not** use OpenClaw's Matrix channel (no Matrix client or Matrix token is involved). Instead, Filament becomes its *own* custom channel: **inbound** work arrives via a `poll_work` long-poll over MCP (not a Matrix sync, and no longer FCM — see "Architecture" above), and **outbound** replies are sent over Filament's MCP-over-HTTP agents API. Registering as a channel is also the only way a third-party plugin can wake an agent turn on an inbound message — see the next section.

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

**Conclusion — the implementation must be an OpenClaw channel plugin.** The lightweight "background service wakes a turn with `scheduleSessionTurn`" path is a dead end for a third-party plugin (bundled-only). The only turn-waking path open to us is `api.registerChannel(...)`: we register Filament as a native messaging channel, and the gateway drives the loop — a `poll_work` item becomes a channel message that wakes an agent turn, and the agent's reply comes back to our channel adapter, which posts it to Filament over MCP via `reply_with`. This is also the closest analog to how the Python `filament-hermes` plugin subclasses a gateway platform adapter. (See `ROADMAP.md` for the SDK checkpoint that pinned the exact contract this relies on.)

### Required trust step after install

Because channel registration requires the plugin to be **enabled/trusted**, installation is not complete until you enable it (this is also what silences the gateway's `plugins.allow is empty … non-bundled plugins may auto-load` warning):

```bash
openclaw plugins enable filament-fcm          # sets plugins.entries.filament-fcm.enabled = true
# equivalently / additionally, add it to the trust allow-list:
openclaw config set plugins.allow '["filament-fcm"]'
```

## Current Progress

This is a **PoC of the `poll_work` transport** (build/lint/typecheck/unit-tests only — no
live-gateway smoke test on this host; see `ROADMAP.md`). The plugin registers a Filament
**channel** whose `startAccount` runs the whole integration:

- **Bootstrap** (`src/connect.ts`) — resolves the configured token to a bearer: a connect
  token (`fmcp_…`) is exchanged once via the RFC 8693 token-exchange grant and the resulting
  bearer is persisted (`src/token-store.ts`); a persisted bearer or an already-issued bearer is
  used directly, skipping the exchange. `initialize` + `get_self` then run as a read-only
  verification step (learns the agent's identity), and a 20s heartbeat keeps presence.
- **Poll loop** (`src/poll-work.ts`) — a sequential, cancelable `poll_work` long-poll
  (`wait_seconds: 60, max_items: 1`): for each item, dispatch one agent turn, publish at most
  once via `reply_with`, then poll again immediately (no timer). Exponential backoff with
  jitter on transient poll_work failures (network/5xx/429/protocol); an auth failure stops the
  loop and leaves the account in a paused/error status rather than hot-looping or silently
  restarting.
- **Dispatch** (`src/inbound-dispatch.ts` + `src/channel.ts`) — one turn per item, with all of
  the item's `messages[]` (sender + event_id preserved) and a session isolated per
  account/channel/thread (Matrix IDs keep their case). Only `final` dispatcher callbacks are
  collected and joined; a single publish is attempted only if there is finalized text.
  `commandAuthorized` is only ever true for `is_backchannel` items.
- **FCM removed** — no push socket and no first-contact greeting. Joining a loop (previously an
  opt-in auto-accept sweep) is now the agent's own call: `filament_accept_invite` and
  `filament_accept_vouch` are exposed as ordinary tools (see "Tools exposed to the agent"
  below) instead of a background loop guessing when to accept on the agent's behalf. See
  `ROADMAP.md`'s "Limitations" for what else that trades away.
- **Tools** (`src/filament-tools.ts`) — after connect, every tool from Filament's live
  `tools/list` (minus `poll_work` and the two FCM push-token tools) is registered as an
  OpenClaw agent tool, `filament_`-prefixed, with per-call authorization gating writes to
  Filament-originated turns and Ring-0 tools to the backchannel. See "Tools exposed to the
  agent" below.

See [`ROADMAP.md`](ROADMAP.md) for status, the acceptance criteria this PoC does and does not
meet yet, and what's next.

## Requirements

- OpenClaw `>= 2026.7.0` (the gateway provides the `openclaw` peer dependency)
- Node `>= 22.22.3`

## Install (from this private git repository)

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

- The repo is private: the host needs an SSH key with access, hence the
  `git@github.com:` form.
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

Verify it loaded by checking the gateway log for `filament: registered channel 'filament'` and the `filament-connect:` startup lines (bearer resolved/exchanged, identity resolved), followed by `filament-poll:` lines once the poll loop starts.

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
| `connectToken` (config) / `FILAMENT_MCP_TOKEN` (env) | A connect token (`fmcp_…`, exchanged once and the bearer persisted) or an already-issued bearer, used directly. |
| `mcpUrl` (config) / `FILAMENT_MCP_URL` (env)         | Filament's `/mcp/agents` endpoint (defaults to production; set for staging/local). |
| `pollWaitSeconds` (config)                           | How long (seconds) each `poll_work` long-poll blocks server-side waiting for work. Default **30**, clamped to `[1, 60]`. 30 matches the server's own default and stays clear of ~60s intermediary timeouts (e.g. the `filament-dev.local` nginx dev proxy), which would otherwise race the server's own wait and surface as a spurious `HTTP 504`. |

Local setup (against a local Synapse with `poll_work` behind the `agent_poll_work` feature
flag — see `synapse-local-dev.md` and `filament feature-flag enable agent_poll_work --user
<agent>` in the workspace root):

```bash
FILAMENT_MCP_TOKEN=fmcp_... FILAMENT_MCP_URL=http://localhost:8008/mcp/agents \
  openclaw plugins enable filament-fcm
```

## Tools exposed to the agent

Once connected, `src/filament-tools.ts` registers every tool from Filament's live `tools/list`
response as an OpenClaw agent tool, name-prefixed `filament_` (e.g. `filament_post_message`) —
in parity with how the Python `filament-hermes` plugin exposes the same MCP server's tools to
its agent. This is on top of, and separate from, the poll loop's own `reply_with` publish (see
"Architecture" and "Interaction with the poll loop" below).

**Excluded:** `poll_work` (the poll loop owns it exclusively — the agent must never call it) and
`register_push_token`/`list_push_tokens` (FCM harness plumbing; this plugin uses `poll_work`, not
FCM, so these tools have nothing to register). Everything else the server returns — **including**
`post_message`, `reply_in_thread`, `message_principal`, `accept_invite`, `accept_vouch` — is
registered, filtered to a reviewed name allowlist (`KNOWN_TOOL_NAMES` in `src/filament-tools.ts`,
mirrored in `openclaw.plugin.json`'s `contracts.tools`) so a brand-new server-side tool doesn't
reach the model without a review pass.

**Authorization** (checked inside each tool's `execute()`, since OpenClaw's `registerTool` has no
channel/session-scoping option — see the module docstring in `src/filament-tools.ts` for the full
reasoning and its documented limitation):

| Tier | Rule | Tools |
| --- | --- | --- |
| **Read** | Always allowed, any turn. | Every tool whose live schema sets `annotations.readOnlyHint: true` — `list_channels`, `list_loop_channels`, `get_channel_details`, `get_recent_messages`, `search_messages`, `get_thread`, `get_user_profile`, `search_members`, `list_mentions`, `list_reactions`, `list_pending_invites`, `list_vouches`, `get_self`, `get_backchannel`. |
| **Ring 0** (principal-only) | Allowed only during a turn dispatched from the backchannel (`item.is_backchannel === true`). | `set_profile` — Filament's own tool declares this `agent self-configuration, not channel content` (synapse `tools_config.py`), matching `filament-hermes/docs/agent-boundaries.md` §5's "tools that change the agent are Ring 0 and principal-only". A tool whose `readOnlyHint` is missing or malformed also falls here (fail closed). |
| **Write** | Allowed during any turn this plugin's own poll loop dispatched (backchannel or group) — denied if called with no active Filament turn at all (e.g. from a different channel's turn). | Everything else: `post_message`, `message_principal`, `reply_in_thread`, `react`, `unreact`, `mark_read`, `set_status`, `accept_invite`, `accept_vouch`, `join_channel`, `leave_channel`, `create_channel`, `rechat`, `quote`, `set_channel_notification_level`. |

A denied or failed call throws (OpenClaw's own tool convention — "throw on failure instead of
encoding errors in content", per its SDK types); calls are logged as
`filament-tools: filament_<name> ok|denied|failed`, without request/response bodies.

### Interaction with the poll loop's own publish

The poll loop still attempts exactly one `reply_with` publish per item after the turn finishes
(see "Architecture"). If the model already answered the item itself via a tool call
(`filament_post_message`/`filament_reply_in_thread`/`filament_message_principal`) during the
turn, Filament's work ledger rejects the loop's own publish as a duplicate
(`work_ledger.AlreadyAnswered`, surfaced as `{"error": "You have already answered this
message…"}` — HTTP 200, no `isError`). `src/channel.ts` recognizes that specific message and
treats the item as `published` (logging `filament: item already answered by a tool call; skipping
publish`) rather than as a publish failure.

## Local setup and limitations

This PoC needs a live Filament gateway to exercise end to end; nothing here starts one. Known
limitations (see `ROADMAP.md` for the full detail and the acceptance criteria this maps to):

- **`poll_work` itself carries no invites/vouches.** It only ever returns `m.room.message` work,
  so an agent that isn't already in a conversation has no way to join one through the poll
  transport alone. There is no more background sweep for this — `filament_accept_invite` and
  `filament_accept_vouch` are ordinary tools the agent calls itself (see "Tools exposed to the
  agent"), so joining a loop is a decision made in the same turn as any other action, not a
  standing policy switch.
- **The reachability probe may report `push_path_silent`.** Filament's probe still pings over
  FCM; a poll-only agent has no FCM registration to answer it, so the probe's health signal is
  stale for this transport (documented, not fixed here).
- **Publish recovery is not durable.** A publish that fails or returns an ambiguous result
  pauses the account with a diagnostic rather than guessing whether the reply went through;
  there is no cross-restart/cross-worker exactly-once guarantee (the server-side work ledger is
  per-process and expires after 10 minutes).
