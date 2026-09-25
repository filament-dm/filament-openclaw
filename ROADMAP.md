# Roadmap: OpenClaw ↔ Filament parity

This plugin connects an OpenClaw agent to Filament over one of two transports: **FCM** (the
default, what production Filament serves) or **`poll_work`** (opt-in, `transport: "poll"`). This
document maps what the current PoC covers, what it deliberately defers, and the path toward a
robust migration.

The `poll_work` validation lives in the maintainers' planning notes (RFC-007, "OpenClaw as a
`poll_work` channel plugin"), outside this repository: the seven findings behind the transport,
the acceptance criteria, and the SDK checkpoint that pinned the target version and resolved the
open contract questions below.

## Where we are today (PoC)

Build/lint/typecheck/unit-tests pass; **no live-gateway smoke test on this host** (no OpenClaw
install, no running Synapse with `poll_work` enabled here — see "Verification still needed").

- **Layout**: the shared layer in `src/` (settings, connect, turn, tools, gateway) and one
  directory per transport in `src/transports/`, which never import each other.
- **Bootstrap** (`src/connect.ts`, `src/credentials.ts`): the bearer — the connect token itself
  for `fcm`, a one-time persisted RFC 8693 exchange for `poll` — then `initialize` + `get_self`
  and an independent 20s heartbeat.
- **FCM** (`src/transports/fcm/`, default): the original plugin's receiver and decoder,
  per account; a port of Hermes' wake policy, threaded replies per the participation rules, and
  a one-reply guard in place of the work ledger. Needs nothing beyond develop's agents API.
- **Poll** (`src/transports/poll/`): sequential, cancelable `poll_work` long-poll
  (`max_items: 1`), backoff with jitter on transient failures, hard stop (no restart) on auth
  failure or a dispatch/publish error; one publish attempt via `reply_with`.
- **Dispatch** (`src/turn.ts`): one turn per item, session isolated per
  account/channel/thread, only `final` callbacks collected.

## Tool surface

`src/filament-tools.ts` registers Filament's MCP tool surface as OpenClaw agent tools, in
parity with `filament-hermes`'s *intent* (which does the same against the same server) but not
its live-fetch mechanism. Registration used to be tied to the connect sequence rather than the
plugin's synchronous `register(api)` entry point, on the theory that OpenClaw's plugin entry has
no async variant but the live tool list needs an MCP round trip only possible after a resolved
bearer. **That theory turned out to be the wrong risk to worry about.** A live-gateway log
(`2026.9.5`, `plans/openclaw/tools-not-visible-diagnosis.md`) confirmed `api.registerTool()`
calls made after `register(api)` returns *are* honored by the mutable process-wide registry —
but a harness (Codex app-server, via deferred/searchable dynamic tools) can resolve a session's
toolset from that registry *before* the late write lands, so the tools were registered but
invisible to that particular session. The fix: register every tool synchronously inside
`register(api)`, from a schema **snapshotted ahead of time** (`npm run snapshot:tools` →
`src/filament-tools.snapshot.json`) rather than fetched live — this removes the race outright,
since nothing can resolve a toolset before `register(api)` has finished. `tools/list` is still
called once after connect, but only to log drift against the snapshot, never to register
anything. Authorization (read/Ring-0/write tiers) is unchanged: enforced per call inside each
tool's `execute()` via a module-level "current turn" flag set by `src/channel.ts`, because
`ExtensionContext` carries no session/channel identity and `registerTool`'s options are just
`{name, names, optional}` — no channel-scoping primitive exists to do this at registration time.
Full detail in the README's "Tools exposed to the agent".

## The architecture (unchanged from the FCM design)

Hermes' inbound loop is: decode push → `handle_message(event)` → **the gateway runs the
LLM** → `adapter.send()` → `post_message`. The plugin is plumbing; the gateway owns the
harness. OpenClaw is the same shape: our plugin feeds inbound work to the agent and gets the
reply back out — only the inbound transport changed (long-poll instead of a push socket).

### Why a channel, not turn injection (Phase 0, resolved against gateway `2026.7.1-2` / `0790d9f`)

OpenClaw gates `scheduleSessionTurn` (the "wake a turn" call) to `origin === "bundled"`
plugins — plugins shipped inside the OpenClaw package. A git/npm-installed plugin is
`origin: global`/`config` and can **never** be `bundled`, and user trust
(`plugins.allow` / `entries.<id>.enabled`) does not change origin. So a background service
cannot wake a turn. `enqueueNextTurnInjection` is *not* origin-gated but only decorates the
next turn (doesn't start one). **`registerChannel` is not origin-gated** (it only rejects a
*disabled workspace* plugin), so the supported path is to register Filament as a native
**channel plugin** and let the gateway drive inbound→turn→outbound. See the README's "Plugin
trust and the OpenClaw origin gate".

### SDK contract, pinned during the poll_work migration (2026.7.1-2, commit `0790d9f`)

Verified by installing `openclaw@2026.7.1-2` as an exact devDependency and reading the real
`.d.ts` files under `node_modules/openclaw/dist/` (not just the docs/source browsed earlier):

- `abortSignal` is a **required** field of `ChannelGatewayContext` (not optional) — every
  `startAccount` gets one.
- The manifest field is `setupWizard`, not `setupEntry`; it's optional, and this plugin doesn't
  set one.
- `OutboundReplyPayload` (the plugin-facing normalized payload) has **no `isError` field** —
  only the lower-level dispatcher's `onError`/`onSkip` hooks and `info.kind` ("tool" | "block" |
  "final") tell a plugin what happened. This is why `src/turn.ts` composes the
  low-level `dispatchReplyWithBufferedBlockDispatcher` primitives directly instead of using
  `dispatchInboundDirectDmWithRuntime`: that one-call DM facade forwards every dispatcher
  callback to `deliver` **without** the `kind` info, so a caller can't tell a `final` from an
  intermediate `block`/`tool` callback — which a single-publish-per-item design needs to get
  right. The real export name for the reply-pipeline helper is also
  `createChannelMessageReplyPipeline`, not `createChannelReplyPipeline` (a real bug the type
  install caught).
- Thread-scoped session isolation with case preserved uses
  `resolveThreadSessionKeys({baseSessionKey, threadId, normalizeThreadId})` from
  `openclaw/plugin-sdk/routing` — its default thread-id normalizer lowercases, so a custom
  identity normalizer is required to keep a Matrix event id's case intact.
- Returning from `startAccount` without waiting for `ctx.abortSignal` triggers the gateway's own
  recovery/auto-restart (it logs "channel exited without an error" and restarts on a backoff).
  That is the right behavior for the idle/no-token case, but wrong for a fatal
  auth/dispatch failure — restarting would just hit the same failure again. So on a fatal
  condition, `src/channel.ts` sets an error status via `ctx.setStatus` **and keeps holding the
  account open** (awaiting abort) rather than returning, so the gateway never auto-restarts a
  poll loop that just told us to stop. This is a judgment call under an unverified assumption
  (no live gateway here to confirm the exact recovery behavior) — flag it in review if the
  real gateway behaves differently.

## Limitations (explicit, not silently dropped)

- **`poll_work` itself carries no invites/vouches.** `poll_work` only surfaces `m.room.message`
  work (see `tools_poll.py:261`); it doesn't deliver `add_to_channel`/`add_to_space`/
  `knock_invite_received`/reactions/the `io.filament.ping` liveness ping. An agent that isn't
  already in a conversation has no way to join one through the poll transport alone. This is now
  covered by the tool surface itself: `filament_list_pending_invites`/`filament_accept_invite`/
  `filament_list_vouches`/`filament_accept_vouch` are ordinary registered tools (see
  `src/filament-tools.ts`) the agent calls when asked, rather than a standing background
  reconciliation loop.
- **The reachability probe may report `push_path_silent`.** `probe.py` still pings over FCM;
  a poll-only agent has no FCM registration to answer, so its "reachable" signal is stale for
  this transport. The heartbeat loop keeps presence working independently of the probe.
- **Publish recovery is not durable across restarts/workers.** The MCP client only ever
  attempts one publish per item; a failed or ambiguous result (no HTTP success + `event_id`)
  pauses the account with a diagnostic instead of guessing. Separately, the *server's* write
  path claims an item (`record_issued`/`claim_reply`) before confirming the send — a send
  failure after the claim can strand the item outside future polls with that cursor. Fixing
  that is server-side work (`work_ledger.py`/`tools_write.py`), tracked separately and not
  part of this plugin's change.
- **The poll cursor is kept in memory only** (not persisted — see `src/token-store.ts`'s
  header). A restart re-scans from the start of unread work; this is safe (already-answered
  items are skipped server-side) but means a redelivered item runs a fresh agent turn rather
  than resuming a partial one.
- **DM classification beyond the backchannel is deferred.** `poll_work` items carry
  `is_backchannel` but no general conversation-type flag, so every non-backchannel item is
  routed through the per-channel/group session path, even a true 1:1 DM outside the
  backchannel. `commandAuthorized` is only ever true for `is_backchannel` items regardless.

## Verification still needed

No OpenClaw install and no running Synapse with `poll_work` enabled on this host, so the
following are unverified beyond build/lint/typecheck/unit-tests with a fake MCP client:

- Loading the plugin against a real gateway (`openclaw plugins install --link ...`) and
  confirming `ctx.channelRuntime`'s real shape matches what `src/turn.ts` assumes
  (session/routing/reply sub-objects, `dispatchReplyWithBufferedBlockDispatcher`'s actual
  `info.kind` values in practice).
- An end-to-end turn against a live agent: multiple `final` callbacks joined correctly, a
  thread reply (`reply_in_thread`) landing on the right anchor, and the fatal-status behavior
  on an auth failure actually preventing the gateway from restarting the account.
- The token-exchange call against a real Synapse (`oauth_token.py`'s
  `_exchange_connect_token`), including the `authorization_pending` retry path while an agent
  finishes onboarding in the Filament app.
- **Resolved against a live gateway (`2026.9.5`):** `api.registerTool()` calls made late (from
  `startAccount`, after `register(api)` returns) *are* honored by the process-wide registry, but
  a harness can resolve its toolset before that late write lands — see
  `plans/openclaw/tools-not-visible-diagnosis.md`. This plugin no longer registers late at all
  (see "Tool surface" above), so the question is moot for us going forward; still open: whether
  the fix actually restores visibility on a live gateway (no live gateway on this host to
  confirm), and whether `openclaw gateway restart` (vs. a plugin reload) is really needed for an
  *upgrade* of an already-installed plugin to reach a session that resolved its toolset before
  the upgrade — flagged as a hypothesis in the README's "Tools exposed to the agent".
- Whether `ctx: ExtensionContext` inside a tool's `execute()` truly carries nothing that
  identifies the originating channel/session (asserted from reading the `.d.ts` files and stock
  plugin source under the installed OpenClaw, never exercised live).

## MCP tools used

By the plugin's own transport: `initialize`, `get_self`, `heartbeat`, `poll_work`, and whatever
`reply_with.tool` names (`post_message` or `reply_in_thread`, both invoked generically via
`FilamentMcpClient.replyWith` with `reply_with.args` plus `markdown_body`). `message_principal`
is no longer used by the plugin itself — the connect-time greeting that used it is removed — but
it is exposed to the agent (see below), so the model may call it directly. `tools/list` is no
longer part of the connect sequence proper: it's called once, after connect, purely to log drift
against the schema snapshot (see "Tool surface" above), and separately by
`scripts/snapshot-tools.mjs` (`npm run snapshot:tools`) to regenerate that snapshot offline.

By the agent, as registered tools (`src/filament-tools.ts`): every tool in
`src/filament-tools.snapshot.json` except `poll_work` and the two FCM push-token tools (already
excluded from the snapshot), registered synchronously at plugin load and mirrored in
`openclaw.plugin.json`'s `contracts.tools` (a unit test asserts the two stay equal — see the
README's "Tools exposed to the agent" for the full list and the authorization rules).

## Notes / open questions

- **How much of Hermes' framing to keep** (e.g. wake-policy prompts, control-vs-reactive
  planes): still the biggest parity judgment call, unaffected by the transport change.
- **Media** (images/attachments) is not addressed by `poll_work`'s `messages[]` shape
  (`body` is text only); parity here is a separate, later piece of work.
