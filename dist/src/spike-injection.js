const MAIN_SESSION_KEY = "agent:main:main";
const SPIKE_TAG = "filament-spike";
const SPIKE_PROMPT = "[filament-spike] Phase 0 injection test. If you can read this, reply with exactly the token: SPIKE_OK";
const OBSERVED_HOOKS = [
  "message_sending",
  "message_sent",
  "message_received",
  "agent_turn_prepare",
  "reply_payload_sending"
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function safeJson(value, cap = 2e3) {
  let out;
  try {
    out = JSON.stringify(value, replaceUnserializable());
  } catch {
    out = String(value);
  }
  return out.length > cap ? `${out.slice(0, cap)}\u2026(+${out.length - cap} chars)` : out;
}
function replaceUnserializable() {
  const seen = /* @__PURE__ */ new WeakSet();
  return (_key, val) => {
    if (typeof val === "bigint") return `${val}n`;
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    return val;
  };
}
function registerInjectionSpike(api) {
  const log = (message) => {
    if (api.logger?.info) api.logger.info(message);
    else console.log(message);
  };
  log("filament-spike: enabled (FILAMENT_SPIKE_ENABLED). This is throwaway Phase 0 scaffolding.");
  if (typeof api.registerHook === "function") {
    for (const name of OBSERVED_HOOKS) {
      try {
        api.registerHook(name, (event) => {
          log(`filament-spike: hook '${name}' fired \u2192 ${safeJson(event)}`);
          return void 0;
        });
        log(`filament-spike: observing hook '${name}'`);
      } catch (error) {
        log(`filament-spike: could not register hook '${name}': ${String(error)}`);
      }
    }
  } else {
    log("filament-spike: api.registerHook unavailable; cannot observe reply seams");
  }
  api.registerService({
    id: "filament-spike",
    start: async () => {
      const schedule = api.session?.workflow?.scheduleSessionTurn;
      if (typeof schedule !== "function") {
        log(
          "filament-spike: session.workflow.scheduleSessionTurn is unavailable on this gateway; cannot wake a turn (unknown #1 unresolved \u2014 check the OpenClaw version)"
        );
        return;
      }
      await sleep(5e3);
      log(
        `filament-spike: scheduling a woken turn on '${MAIN_SESSION_KEY}' with a hard-coded prompt\u2026`
      );
      try {
        const result = await schedule({
          sessionKey: MAIN_SESSION_KEY,
          message: SPIKE_PROMPT,
          delayMs: 500,
          deleteAfterRun: true,
          tag: SPIKE_TAG
        });
        log(`filament-spike: scheduleSessionTurn returned \u2192 ${safeJson(result)}`);
        log(
          "filament-spike: now watch for a hook firing with the reply text (and for a ProviderAuthError if no model is configured)."
        );
      } catch (error) {
        log(`filament-spike: scheduleSessionTurn threw \u2192 ${String(error)}`);
      }
    }
  });
}
export {
  registerInjectionSpike
};
//# sourceMappingURL=spike-injection.js.map
