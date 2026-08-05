/**
 * Phase 0 spike (see ROADMAP.md) — THROWAWAY scaffolding, gated behind
 * FILAMENT_SPIKE_ENABLED. Delete once the inbound→agent→outbound contract is
 * decided.
 *
 * It answers the two unknowns that Phases 4–5 are built on:
 *
 *   1. Can a background plugin service WAKE an agent turn with an injected
 *      message? We call `api.session.workflow.scheduleSessionTurn(...)` on the
 *      main session with a hard-coded prompt and log the result.
 *
 *   2. Which seam carries the agent's REPLY so we can intercept it and post it
 *      to Filament ourselves (rather than let OpenClaw deliver it to a channel
 *      we don't have)? We register several observation hooks and log whichever
 *      fires with the reply text.
 *
 * Prerequisite: the gateway agent needs a model provider configured (e.g.
 * `openclaw agents add main`, or an API key), otherwise the woken turn fails at
 * the LLM step with a ProviderAuthError — which still proves unknown #1 (the
 * turn fired), just without a reply to observe for unknown #2.
 */

// The default agent session (OpenClaw's MAIN_SESSION_KEY). Matches the
// `lane=session:agent:main:main` seen in the gateway logs.
const MAIN_SESSION_KEY = "agent:main:main";
const SPIKE_TAG = "filament-spike";
const SPIKE_PROMPT =
  "[filament-spike] Phase 0 injection test. If you can read this, reply with " +
  "exactly the token: SPIKE_OK";

// Hooks that plausibly carry an agent reply (or turn lifecycle). We register all
// of them and log whichever fire, so the spike run tells us which seam to use.
const OBSERVED_HOOKS = [
  "message_sending",
  "message_sent",
  "message_received",
  "agent_turn_prepare",
  "reply_payload_sending",
];

// Structural view of just the API surface the spike touches. Loose on purpose
// (handlers typed `any`) so the real OpenClawPluginApi is assignable without
// pulling the full SDK types into this throwaway module.
export interface SpikeApi {
  logger?: { info?: (message: string) => void };
  // oxlint-disable-next-line typescript/no-explicit-any
  registerHook?: (events: string | string[], handler: (event: any) => any, opts?: unknown) => void;
  registerService: (service: {
    id: string;
    // oxlint-disable-next-line typescript/no-explicit-any
    start: (ctx: any) => void | Promise<void>;
    // oxlint-disable-next-line typescript/no-explicit-any
    stop?: (ctx: any) => void | Promise<void>;
  }) => void;
  session?: {
    workflow?: {
      scheduleSessionTurn?: (params: {
        sessionKey: string;
        message: string;
        delayMs?: number;
        deleteAfterRun?: boolean;
        tag?: string;
      }) => Promise<unknown>;
    };
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function safeJson(value: unknown, cap = 2_000): string {
  let out: string;
  try {
    out = JSON.stringify(value, replaceUnserializable());
  } catch {
    out = String(value);
  }
  return out.length > cap ? `${out.slice(0, cap)}…(+${out.length - cap} chars)` : out;
}

/** JSON replacer that survives circular refs and bigints. */
function replaceUnserializable() {
  const seen = new WeakSet<object>();
  return (_key: string, val: unknown) => {
    if (typeof val === "bigint") return `${val}n`;
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    return val;
  };
}

/**
 * Wire the Phase 0 spike into a plugin. Registers observation hooks immediately
 * and schedules one woken turn shortly after the gateway settles.
 */
export function registerInjectionSpike(api: SpikeApi): void {
  const log = (message: string) => {
    if (api.logger?.info) api.logger.info(message);
    else console.log(message);
  };

  log("filament-spike: enabled (FILAMENT_SPIKE_ENABLED). This is throwaway Phase 0 scaffolding.");

  // 1. Observe every plausible reply seam.
  if (typeof api.registerHook === "function") {
    for (const name of OBSERVED_HOOKS) {
      try {
        api.registerHook(name, (event: unknown) => {
          log(`filament-spike: hook '${name}' fired → ${safeJson(event)}`);
          // Observe only — do not alter or cancel the turn.
          return undefined;
        });
        log(`filament-spike: observing hook '${name}'`);
      } catch (error) {
        log(`filament-spike: could not register hook '${name}': ${String(error)}`);
      }
    }
  } else {
    log("filament-spike: api.registerHook unavailable; cannot observe reply seams");
  }

  // 2. Wake a turn once the runtime has settled.
  api.registerService({
    id: "filament-spike",
    start: async () => {
      const schedule = api.session?.workflow?.scheduleSessionTurn;
      if (typeof schedule !== "function") {
        log(
          "filament-spike: session.workflow.scheduleSessionTurn is unavailable on this gateway; " +
            "cannot wake a turn (unknown #1 unresolved — check the OpenClaw version)",
        );
        return;
      }
      await sleep(5_000);
      log(
        `filament-spike: scheduling a woken turn on '${MAIN_SESSION_KEY}' with a hard-coded prompt…`,
      );
      try {
        const result = await schedule({
          sessionKey: MAIN_SESSION_KEY,
          message: SPIKE_PROMPT,
          delayMs: 500,
          deleteAfterRun: true,
          tag: SPIKE_TAG,
        });
        log(`filament-spike: scheduleSessionTurn returned → ${safeJson(result)}`);
        log(
          "filament-spike: now watch for a hook firing with the reply text " +
            "(and for a ProviderAuthError if no model is configured).",
        );
      } catch (error) {
        log(`filament-spike: scheduleSessionTurn threw → ${String(error)}`);
      }
    },
  });
}
