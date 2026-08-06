# Roadmap: OpenClaw ↔ Filament parity

This plugin can **onboard** an agent and keep it **online**, and it **registers for
push** — but it does not yet **act on** the pushes it receives. This document maps the
path from "connected and registered" to full parity with the Python `filament-hermes`
plugin's inbound message loop.

## Where we are today

Working end-to-end (verified live against local Synapse + a lima gateway):

- **Connect sequence** (`src/connect.ts`): initialize → `get_self` poll → accept pending
  invites/vouches → FCM register → `register_push_token` → heartbeat loop →
  first-contact greeting.
- **Presence**: the heartbeat loop keeps the agent showing **online** in Filament.
- **FCM registration**: `register_push_token` tells Filament to push to us, and
  `FcmConnection` holds an open MCS socket, so **pushes do arrive at the socket**.

The gap:

- **Inbound pushes are dropped on the floor.** `FcmConnection` never subscribes to
  `receiver.onNotification`, so nothing decodes or dispatches an incoming message.
- **No dedup across restarts.** `start()` passes `persistentIds: []` and we don't persist
  received IDs, so a restart invites Google to **redeliver** everything. Hermes avoids
  this with a durable received-ID store seeded into each MCS login.

## The architecture (and the one unverified assumption)

Hermes' inbound loop is: decode push → `handle_message(event)` → **the gateway runs the
LLM** → `adapter.send()` → `post_message`. The plugin is plumbing; the gateway owns the
harness. OpenClaw is the same shape, so our plugin needs to (a) feed the inbound message
to the agent and (b) get the reply back out.

Two candidate OpenClaw SDK paths (names from a source-exploration pass — **not yet run**,
hence the Phase 0 spike):

- **Turn injection** — `api.session.workflow.enqueueNextTurnInjection({ sessionKey, text,
  idempotencyKey })` to inject the inbound message, then observe a
  `message_sending`/`message_sent` hook to forward the agent's reply back out via MCP.
- **Channel registration** — `api.registerChannel(...)` to become a first-class transport
  the gateway drives bidirectionally (the closest analog to Hermes' adapter: the gateway
  handles session mapping and routes the reply back through our channel's send fn).

⚠️ **The entire reply-generation design hinges on which of these actually works.** Phase 0
resolves it before any downstream phase is built on it.

**RESOLVED (Phase 0, against gateway `2026.7.1-2` / commit `0790d9f`):** turn injection is a
dead end for us and the channel path is the answer. OpenClaw gates `scheduleSessionTurn`
(the "wake a turn" call) to `origin === "bundled"` plugins — plugins shipped inside the
OpenClaw package. A git/npm-installed plugin is `origin: global`/`config` and can **never**
be `bundled`, and user trust (`plugins.allow` / `entries.<id>.enabled`) does not change
origin. So a background service cannot wake a turn. `enqueueNextTurnInjection` is *not*
origin-gated but only decorates the next turn (doesn't start one). **`registerChannel` is
not origin-gated** (it only rejects a *disabled workspace* plugin), so the supported path
is to register Filament as a native **channel plugin** and let the gateway drive
inbound→turn→outbound. See the README's "Plugin trust and the OpenClaw origin gate".

## FCM payload reference (DirectPusher)

`env.message.data` (from `@eneris/push-receiver`'s `MessageEnvelope`) carries the
DirectPusher data dict; `env.persistentId` is the dedup key.

```
data = {
  body: "<JSON-serialized PushPayload>",   // the real content
  room_name, message_text, badge_count, from_directpusher, badge_only, ...
}

PushPayload = {
  event_id, room_id, is_direct,
  branch: {
    type: "direct_message" | "channel_message" | "add_to_channel" | "add_to_space"
        | "knock_invite_received" | "reaction" | ...,
    sender, sender_id,
    content: { text } | null,             // null for media-only (ENG-603)
    channel, thread_id,
    is_mention_of_recipient, is_everyone_mention,
    key, target_event_id,                 // reactions
  },
}
// Non-message payloads (e.g. "io.filament.ping") put the type at top level, no `branch`.
```

## Phases

### Phase 0 — Spike the channel path — ✅ DONE
**Injection-vs-channel question: resolved.** `scheduleSessionTurn` is bundled-only (closed to
a git-installed plugin); `registerChannel` is the supported path (see the resolved note above
and the README).

**Minimal `ChannelPlugin` spike: proven end-to-end** against the lima gateway (`2026.7.1-2`).
The throwaway `src/spike-channel.ts` (env `FILAMENT_CHANNEL_SPIKE_ENABLED`) registered a
minimal `filament-echo` direct-message channel; the gateway started it (only `enabled` is
required — no channel config), a synthetic inbound woke a real agent turn on `agent:main:main`,
and the reply came back to our `deliver` callback as `{ text }`. (Reply text was an
auth-error only because no model provider is configured — the pipeline itself works.)

Findings that feed the real implementation:
- **Minimal working surface:** `id` + `meta` + `capabilities: { chatTypes: ["direct"] }` +
  `config: { listAccountIds, resolveAccount }` + `gateway.startAccount`. Wake a turn from
  `startAccount` via `dispatchInboundDirectDmWithRuntime(...)` (exported from
  `openclaw/plugin-sdk/channel-inbound`), passing `runtime: { channel: ctx.channelRuntime }`.
- **Outbound seam:** the `deliver(payload)` callback receives an `OutboundReplyPayload`
  (`{ text }`) — this is where Phase 5 posts to Filament over MCP.
- **`startAccount` must stay alive** (keep the FCM socket open + `await ctx.abortSignal`).
  Returning immediately makes the gateway log `channel exited without an error` and
  auto-restart the channel on a backoff (re-firing inbound each time).
- **Routing:** the inbound resolved to the main agent session (`agent:main:main`); real
  per-conversation routing is Phase 4.

Both throwaway spikes (`src/spike-channel.ts`, and the already-removed `spike-injection.ts`)
can be deleted once the real channel lands.

### Phase 1 — Receive, decode, dedup — ✅ DONE
- `FcmConnection` now takes an `onMessage` callback and wires `receiver.onNotification`,
  seeding `persistentIds` from a durable store and deduping by persistent ID before
  forwarding (`src/fcm.ts`, `src/token-store.ts`).
- Pure `decodeDirectPusher` (`message.data.body` → `PushPayload`) with unit tests
  (`src/inbound-core.ts` / `.test.ts`).
- The `filament` channel logs each decoded push and holds `startAccount` open.
**Exit met:** a Filament message logs a fully-decoded push; restarts don't reprocess.

### Phase 2 — Ping → pong — ✅ DONE
`branchType === "io.filament.ping"` → `connection.client.pong(nonce)` in the channel's
inbound handler. LLM-free.

### Phase 3 — Invites / vouches — partial
Startup acceptance already runs inside `runConnect` (`acceptPending`). Runtime push-driven
handling (`add_to_channel` / `add_to_space` → `acceptInvite`; `knock_invite_received` →
`acceptVouch`) is **not yet wired** — those branch types currently log "not yet handled".
**Remaining:** route those inbound branch types to the existing accept helpers.

### Phase 4 — Message → agent turn — ✅ DONE
Chat pushes (`direct_message` / `channel_message`) wake a turn via
`dispatchInboundDirectDmWithRuntime(...)` with `runtime: { channel: ctx.channelRuntime }`,
routed per-room (`peer.id = roomId`). Fetching full content via `get_thread` for media-only
messages is deferred (text-only for now).
**Exit met:** a chat message produces an agent turn (proven end-to-end in Phase 0).

### Phase 5 — Reply → MCP — ✅ DONE
The `deliver(payload)` callback posts the agent's reply: `message_principal` when the room
is the backchannel (`ccRoomId`), else `post_message(roomId, text)`.
**Exit met:** the reply is posted back to the originating conversation.
**Remaining refinements:** thread-aware replies (`reply_in_thread`) and richer payloads.

### Phase 6 — Advanced parity (scope deliberately; probably don't port wholesale)
Hermes' wake policy, control-vs-reactive planes, per-`(channel, sender)` capability
gating, and disk-backed standing instructions. **Recommendation:** lean on OpenClaw's
**native** agent config / system prompt rather than replicate Hermes' `WAKE-UP SIGNAL`
framing — that framing exists because Hermes injects its own prompt, whereas in OpenClaw
the gateway already owns the system prompt. Treat each of these as an explicit
keep/drop/adapt decision, not a reflexive port.

## MCP tools status

Implemented in `src/mcp-client.ts`: `get_self`, `register_push_token`,
`list_pending_invites`, `accept_invite`, `list_vouches`, `accept_vouch`, `post_message`,
`message_principal`, `heartbeat`, `pong`.

Still to add (Phases 4–5): `get_thread`, `reply_in_thread`, `react`
(and `get_recent_messages` if we want channel breadcrumbs).

## Notes / open questions

- **Callback threading**: `@eneris/push-receiver` fires `onNotification` on Node's event
  loop (no cross-thread bridging needed, unlike the Python `firebase-messaging` port).
- **sessionKey mapping** (Phase 4): needs a stable, reversible mapping from a Filament
  `room_id` (+ sender for DMs) to an OpenClaw `sessionKey`, so replies route back to the
  right conversation. Design during Phase 0/4.
- **How much of Hermes' framing to keep** (Phase 6): the biggest parity judgment call.
