# filament-openclaw

An [OpenClaw](https://docs.openclaw.ai) plugin that connects an agent to [Filament](https://filament.dm). It is the TypeScript counterpart to the Python [`filament-hermes`](https://github.com/filament-dm/filament-hermes) plugin.

## Architecture

Same shape as the Hermes plugin — **no Matrix client or Matrix token is involved**. We do not use OpenClaw's Matrix channel plugin.

- **Inbound (receive):** messages arrive as **Firebase Cloud Messaging (FCM)** data-message pushes from Filament's DirectPusher.
- **Outbound (send/act):** replies go through Filament's **MCP-over-HTTP agents API**, authenticated with an **MCP token** (not a Matrix access token).

## OpenClaw channels

In OpenClaw, a **channel** is a messaging integration that connects a conversation surface to the agent. The bundled channels are things like `discord`, `slack`, `telegram`, `whatsapp`, `imessage`, `signal`, and `matrix`. A channel owns both directions of the loop: it delivers an **inbound** message to the gateway, which wakes an agent turn, and the gateway routes the agent's **outbound** reply *back to the channel it came from* (routing is deterministic and host-controlled — the model does not pick a channel).

- Overview of the built-in channels: <https://docs.openclaw.ai/channels>
- How inbound messages route to a turn and replies route back: <https://docs.openclaw.ai/channels/channel-routing>
- Writing your own channel as a plugin (the SDK contract): <https://docs.openclaw.ai/plugins/sdk-channel-plugins>

This is the mechanism this plugin uses — **but not by adopting a built-in channel.** We deliberately do **not** use OpenClaw's Matrix channel (no Matrix client or Matrix token is involved). Instead, Filament becomes its *own* custom channel: **inbound** messages arrive over FCM (not a Matrix sync), and **outbound** replies are sent over Filament's MCP-over-HTTP agents API. Registering as a channel is also the only way a third-party plugin can wake an agent turn on an inbound message — see the next section.

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

**Conclusion — the implementation must be an OpenClaw channel plugin.** The lightweight "background service wakes a turn with `scheduleSessionTurn`" path is a dead end for a third-party plugin (bundled-only). The only turn-waking path open to us is `api.registerChannel(...)`: we register Filament as a native messaging channel, and the gateway drives the loop — an inbound FCM push becomes a channel message that wakes an agent turn, and the agent's reply comes back to our channel adapter, which posts it to Filament over MCP. This is also the closest analog to how the Python `filament-hermes` plugin subclasses a gateway platform adapter. (The minimal `ChannelPlugin` surface required to wake turns is the next spike; see `ROADMAP.md`.)

### Required trust step after install

Because channel registration requires the plugin to be **enabled/trusted**, installation is not complete until you enable it (this is also what silences the gateway's `plugins.allow is empty … non-bundled plugins may auto-load` warning):

```bash
openclaw plugins enable filament-fcm          # sets plugins.entries.filament-fcm.enabled = true
# equivalently / additionally, add it to the trust allow-list:
openclaw config set plugins.allow '["filament-fcm"]'
```

## Current Progress

- `filament_hello` / `filament_fcm_status` — hello-world tools proving the plugin loads and that `@eneris/push-receiver` + the Firebase config are wired.
- **Onboarding** — completes the Filament connect flow: given a `connectToken`, polls `get_self` over MCP-over-HTTP until the app finalizes the agent, then persists the identity (principal + backchannel). See `src/onboarding.ts`.
- **FCM registration** (opt-in, `FILAMENT_FCM_ENABLED`) — connects via `@eneris/push-receiver` and caches the registration token in the plugin-state store (`src/fcm.ts`).
- **Conformance control surface** (opt-in, `FILAMENT_CONFORMANCE_ENABLED`) — `GET /conformance/manifest` + `POST /conformance/op`.

Still to do: `register_push_token` (hand Filament our FCM token so it actually pushes to us), inbound DirectPusher payload parsing/dispatch, and the outbound reply path.

## Requirements

- OpenClaw `>= 2026.7.0` (the gateway provides the `openclaw` peer dependency)
- Node `>= 22.22.3`

## Install (from this private git repository)

This plugin is **not published to ClawHub or npm**. Install it straight from git. Non-ClawHub sources require `--force` to confirm trust:

```bash
# Latest on the default branch
openclaw plugins install git:github.com/filament-dm/filament-openclaw --force

# Or pin a tag/branch/commit
openclaw plugins install git:github.com/filament-dm/filament-openclaw@v0.1.0 --force
```

Then enable it and restart the gateway so the new code loads (managed gateways auto-restart):

```bash
openclaw plugins enable filament-fcm
openclaw plugins list --enabled
```

Verify it works from an agent session by calling the `filament_hello` or `filament_fcm_status` tool.

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
npm run build        # compile index.ts + src/fcm.ts -> dist/ (esbuild)
npm run typecheck    # tsc --noEmit
npm run format       # oxfmt (write in place)
npm run lint         # oxlint
```

Formatting and linting also run as pre-commit hooks via [prek](https://github.com/j178/prek) (`prek install` to enable); CI runs the same hooks — see `.github/workflows/pre-commit.yml`.

## Build

The plugin is TypeScript, compiled to ESM JavaScript with esbuild. `npm run build` transpiles `index.ts` and `src/fcm.ts` into `dist/` (runtime deps left external); the `prepare` script runs it automatically on `npm install` / `npm ci`, so `dist/` points at `./dist/index.js` (see `package.json`'s `openclaw.extensions`).

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

The Firebase project values are public and baked in as defaults (matching `filament-hermes`). Override any of them via environment variables if needed:

| Env var                        | Default                                   |
| ------------------------------ | ----------------------------------------- |
| `FILAMENT_FIREBASE_PROJECT_ID` | `filament-8ce44`                          |
| `FILAMENT_FIREBASE_API_KEY`    | `AIzaSyBtYzzP3IRpmIZ57dp1PMS4Y8RPjTB0snk` |
| `FILAMENT_FIREBASE_APP_ID`     | `1:143821144946:web:90e517a7f36aa42a6093eb` |
| `FILAMENT_FIREBASE_SENDER_ID`  | `143821144946`                            |

The MCP endpoint and MCP token (for the outbound reply path) will be added in a later iteration.

## Roadmap toward parity with `filament-hermes`

1. Live FCM registration + persistent MCS connection + credential persistence.
2. DirectPusher payload parsing (messages, invites, reactions, pings).
3. Outbound replies via Filament's MCP-over-HTTP agents API (MCP token auth).
4. A shared test harness with an adapter for both the Hermes and OpenClaw plugins, to keep behaviour aligned.
