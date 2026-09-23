/**
 * Opt-in sweep for pending loop invites and vouches.
 *
 * `poll_work` only ever delivers `m.room.message` work (see poll-work.ts's
 * module header) — it never surfaces `add_to_channel`/`add_to_space` invites
 * or member vouches (see synapse/synapse/plugins/agents_mcp/tools_read.py's
 * `handle_list_pending_invites`/`handle_list_vouches`). The FCM-era plugin
 * auto-accepted both as part of connect (see `git show c77ef31:src/connect.ts`);
 * this module reintroduces that behavior as an independent, opt-in loop
 * (`autoAcceptInvites` in the plugin config — src/connect.ts's
 * `resolveMcpSettings`) rather than folding it back into connect, since
 * accepting on the agent's behalf is a policy decision, not a transport
 * detail.
 *
 * Best-effort by design: a failing list or accept call is logged and the
 * sweep moves on — it must never throw, and never take down the poll loop or
 * the heartbeat it runs alongside.
 */
import type { CallOptions, ToolCallResult } from "./mcp-client.js";

/** Minimal client surface the sweep needs (matches FilamentMcpClient). */
export interface InviteSweepClient {
  listPendingInvites(opts?: CallOptions): Promise<ToolCallResult>;
  acceptInvite(loopId: string, opts?: CallOptions): Promise<ToolCallResult>;
  listVouches(opts?: CallOptions): Promise<ToolCallResult>;
  acceptVouch(loopId: string, opts?: CallOptions): Promise<ToolCallResult>;
}

/** Extract the `loop_id`s from a list_pending_invites / list_vouches result. */
function loopIds(result: ToolCallResult, key: "invites" | "vouches"): string[] {
  if (!result.ok || !result.data || typeof result.data !== "object") return [];
  const list = (result.data as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return list
    .map((item) =>
      item && typeof item === "object" ? (item as { loop_id?: unknown }).loop_id : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Accept every pending item a list call turned up; best-effort per item. */
async function acceptAll(
  loopIdsToAccept: string[],
  accept: (loopId: string, opts?: CallOptions) => Promise<ToolCallResult>,
  verb: "accept_invite" | "accept_vouch",
  log: (message: string) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
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

/**
 * Run one sweep: list pending invites, accept each; list pending vouches,
 * accept each. Never throws — a failing list call is logged and the other
 * half of the sweep still runs.
 */
export async function runInviteSweep(
  client: InviteSweepClient,
  log: (message: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  try {
    const invites = await client.listPendingInvites({ signal });
    await acceptAll(
      loopIds(invites, "invites"),
      (loopId, opts) => client.acceptInvite(loopId, opts),
      "accept_invite",
      log,
      signal,
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
      signal,
    );
  } catch (error) {
    log(`filament-invites: list_vouches failed (continuing): ${String(error)}`);
  }
}

export interface InviteSweeperOptions {
  client: InviteSweepClient;
  log: (message: string) => void;
  abortSignal: AbortSignal;
  /** Seconds between sweeps. Not re-clamped here — the caller (channel.ts)
   *  passes the already-clamped `resolveMcpSettings().inviteSweepSeconds`. */
  intervalSeconds: number;
}

export interface InviteSweeperHandle {
  stop(): void;
}

/**
 * Start the sweep: run it once immediately, then on a fixed interval. A tick
 * that lands while the previous sweep is still running is skipped rather
 * than queued or run concurrently. Cleared on abort.
 */
export function startInviteSweeper(opts: InviteSweeperOptions): InviteSweeperHandle {
  const { client, log, abortSignal, intervalSeconds } = opts;
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

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
  timer = setInterval(tick, Math.max(1, intervalSeconds) * 1000);
  timer.unref?.();
  abortSignal.addEventListener("abort", stop, { once: true });

  return { stop };
}
