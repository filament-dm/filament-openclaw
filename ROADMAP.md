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

### Phase 0 — Spike the agent-injection path ← **starting here**
Prove that one inbound string can trigger an agent turn whose reply we can capture and
send back out. Confirm `enqueueNextTurnInjection` vs `registerChannel` against a real lima
gateway. Decide the inbound→agent→outbound contract. De-risks Phases 4–5.
**Exit:** a hard-coded string round-trips through the agent and we observe its reply.

### Phase 1 — Receive, decode, dedup ← *the "are messages received?" milestone*
- Subscribe `receiver.onNotification` in `FcmConnection`; parse the DirectPusher envelope
  (`message.data.body` → `PushPayload`).
- Durable received-ID store (extend `src/token-store.ts`); seed `persistentIds` on
  `start()` to stop restart redelivery.
- For now, **just log** decoded messages — this alone proves end-to-end receipt on real
  infra.
**Exit:** sending a Filament message logs a fully-decoded `PushPayload` in the gateway.

### Phase 2 — Ping → pong
`branch_type === "io.filament.ping"` → `client.pong(nonce)` (already implemented).
LLM-free, trivial, makes the principal's connectivity check pass.
**Exit:** a liveness ping from Filament gets a pong; the round-trip check succeeds.

### Phase 3 — Invites / vouches on push
`add_to_channel` / `add_to_space` → `acceptInvite`; `knock_invite_received` →
`acceptVouch` (both already implemented for connect — just route pushes to them).
**Exit:** inviting the agent to a channel while it's running auto-joins it.

### Phase 4 — Message → agent turn (the core)
Uses Phase 0's chosen contract. Map `(room_id, sender)` → a stable `sessionKey`; fetch
content via a new `get_thread` tool when the push lacks the body/media; inject the message
into the agent.
**Exit:** a message to the agent produces an LLM turn with the right context.

### Phase 5 — Reply → MCP
Capture the agent's generated reply and post it via `post_message` / `reply_in_thread` /
`message_principal`, choosing the target from the originating push.
**Exit:** the agent's reply appears in the correct Filament channel/thread.

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
