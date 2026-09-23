function loopIds(result, key) {
  if (!result.ok || !result.data || typeof result.data !== "object") return [];
  const list = result.data[key];
  if (!Array.isArray(list)) return [];
  return list.map(
    (item) => item && typeof item === "object" ? item.loop_id : void 0
  ).filter((id) => typeof id === "string" && id.length > 0);
}
async function acceptAll(loopIdsToAccept, accept, verb, log, signal) {
  for (const loopId of loopIdsToAccept) {
    if (signal?.aborted) return;
    try {
      const res = await accept(loopId, { signal });
      log(`filament-invites: ${verb} ${loopId} ${res.ok ? "ok" : `failed (${res.kind ?? "?"})`}`);
    } catch (error) {
      log(`filament-invites: ${verb} ${loopId} failed (${String(error)})`);
    }
  }
}
async function runInviteSweep(client, log, signal) {
  if (signal?.aborted) return;
  try {
    const invites = await client.listPendingInvites({ signal });
    await acceptAll(
      loopIds(invites, "invites"),
      (loopId, opts) => client.acceptInvite(loopId, opts),
      "accept_invite",
      log,
      signal
    );
  } catch (error) {
    log(`filament-invites: list_pending_invites failed (continuing): ${String(error)}`);
  }
  if (signal?.aborted) return;
  try {
    const vouches = await client.listVouches({ signal });
    await acceptAll(
      loopIds(vouches, "vouches"),
      (loopId, opts) => client.acceptVouch(loopId, opts),
      "accept_vouch",
      log,
      signal
    );
  } catch (error) {
    log(`filament-invites: list_vouches failed (continuing): ${String(error)}`);
  }
}
function startInviteSweeper(opts) {
  const { client, log, abortSignal, intervalSeconds } = opts;
  let running = false;
  let timer = null;
  const tick = () => {
    if (running || abortSignal.aborted) return;
    running = true;
    void runInviteSweep(client, log, abortSignal).finally(() => {
      running = false;
    });
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  tick();
  timer = setInterval(tick, Math.max(1, intervalSeconds) * 1e3);
  timer.unref?.();
  abortSignal.addEventListener("abort", stop, { once: true });
  return { stop };
}
export {
  runInviteSweep,
  startInviteSweeper
};
//# sourceMappingURL=invite-sweep.js.map
