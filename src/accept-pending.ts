import type { FilamentMcpClient } from "./mcp-client.js";

export function loopIds(data: unknown, key: "invites" | "vouches"): string[] {
  if (!data || typeof data !== "object") return [];
  const list = (data as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return list
    .map((item) =>
      item && typeof item === "object" ? (item as { loop_id?: unknown }).loop_id : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export type PendingClient = Pick<
  FilamentMcpClient,
  "listPendingInvites" | "acceptInvite" | "listVouches" | "acceptVouch"
>;

/** Never throws. */
export async function acceptPending(
  client: PendingClient,
  log: (message: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const sweep = async (
    kind: "invites" | "vouches",
    list: () => ReturnType<FilamentMcpClient["listVouches"]>,
    accept: (loopId: string) => ReturnType<FilamentMcpClient["acceptVouch"]>,
  ) => {
    try {
      const res = await list();
      for (const loopId of res.ok ? loopIds(res.data, kind) : []) {
        const accepted = await accept(loopId);
        log(
          `filament: accept ${kind === "invites" ? "invite" : "vouch"} ${loopId} ${accepted.ok ? "ok" : `failed (${accepted.error?.code ?? "?"})`}`,
        );
      }
    } catch (error) {
      log(`filament: pending ${kind} sweep failed (continuing): ${String(error)}`);
    }
  };
  await sweep(
    "invites",
    () => client.listPendingInvites({ signal }),
    (id) => client.acceptInvite(id, { signal }),
  );
  await sweep(
    "vouches",
    () => client.listVouches({ signal }),
    (id) => client.acceptVouch(id, { signal }),
  );
}
