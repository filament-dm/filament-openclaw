# filament-openclaw

An [OpenClaw](https://docs.openclaw.ai) plugin that connects an agent to [Filament](https://filament.dm). It is the TypeScript counterpart to the Python [`filament-hermes`](https://github.com/filament-dm/filament-hermes) plugin.

## Architecture

Same shape as the Hermes plugin — **no Matrix client or Matrix token is involved**. We do not use OpenClaw's Matrix channel plugin.

- **Inbound (receive):** messages arrive as **Firebase Cloud Messaging (FCM)** data-message pushes from Filament's DirectPusher.
- **Outbound (send/act):** replies go through Filament's **MCP-over-HTTP agents API**, authenticated with an **MCP token** (not a Matrix access token).

## Current Progress

- `filament_hello` — a trivial tool that returns a greeting, proving the plugin loads and can register MCP tools.
- `filament_fcm_status` — resolves the FCM registration config and constructs the push receiver **without connecting**, proving `@eneris/push-receiver` is wired and the Firebase config matches the project `filament-hermes` uses.

The live FCM connection, credential persistence, payload parsing, and the MCP-over-HTTP reply path are intentionally **not** here yet.

## Requirements

- OpenClaw `>= 2026.7.2` (the gateway provides the `openclaw` peer dependency)
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

Clone the repo and link it into OpenClaw so edits are picked up without a reinstall:

```bash
npm install
openclaw plugins install --link ./filament-openclaw
openclaw plugins enable filament-fcm
```

Type-check with:

```bash
npm run typecheck
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
