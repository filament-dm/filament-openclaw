function loopIds(data, key) {
  if (!data || typeof data !== "object") return [];
  const list = data[key];
  if (!Array.isArray(list)) return [];
  return list.map(
    (item) => item && typeof item === "object" ? item.loop_id : void 0
  ).filter((id) => typeof id === "string" && id.length > 0);
}
async function acceptPending(client, log, signal) {
  const sweep = async (kind, list, accept) => {
    try {
      const res = await list();
      for (const loopId of res.ok ? loopIds(res.data, kind) : []) {
        const accepted = await accept(loopId);
        log(
          `filament: accept ${kind === "invites" ? "invite" : "vouch"} ${loopId} ${accepted.ok ? "ok" : `failed (${accepted.error?.code ?? "?"})`}`
        );
      }
    } catch (error) {
      log(`filament: pending ${kind} sweep failed (continuing): ${String(error)}`);
    }
  };
  await sweep(
    "invites",
    () => client.listPendingInvites({ signal }),
    (id) => client.acceptInvite(id, { signal })
  );
  await sweep(
    "vouches",
    () => client.listVouches({ signal }),
    (id) => client.acceptVouch(id, { signal })
  );
}
export {
  acceptPending,
  loopIds
};
//# sourceMappingURL=accept-pending.js.map
