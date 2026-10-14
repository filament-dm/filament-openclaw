import { asRecord } from "./accounts.js";
const PREFIX = "Filament \xB7 ";
function membersOf(details) {
  const raw = Array.isArray(details.members) ? details.members : [];
  return raw.flatMap((entry) => {
    const member = asRecord(entry);
    if (typeof member.mxid !== "string" || !member.mxid) return [];
    const display = typeof member.display_name === "string" ? member.display_name.trim() : "";
    return [{ mxid: member.mxid, name: display || member.mxid }];
  });
}
function roomLabelFrom(details, roomId, identity) {
  const data = asRecord(details);
  const members = membersOf(data);
  if (roomId === identity.ccRoomId) {
    const owner = members.find((m) => m.mxid === identity.principal)?.name ?? identity.principal;
    return { label: `${PREFIX}${owner}` };
  }
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (name && name !== roomId) return { label: `${PREFIX}${name}`, subject: name };
  const others = members.filter((m) => m.mxid !== identity.mxid).map((m) => m.name);
  if (others.length > 0) {
    const people = peopleLabel(others);
    return { label: `${PREFIX}${people}`, subject: people };
  }
  return { label: `${PREFIX}${roomId}` };
}
function peopleLabel(names) {
  return names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
}
function roomLabelFromFacts(facts, roomId, senders, identity) {
  const names = facts.sender_names;
  if (!names) return null;
  if (roomId === identity.ccRoomId) {
    const owner = names[identity.principal];
    return owner ? { label: `${PREFIX}${owner}` } : null;
  }
  const name = facts.channel_name;
  if (name && name !== roomId) return { label: `${PREFIX}${name}`, subject: name };
  const others = [...new Set(senders)].filter((id) => id !== identity.mxid).map((id) => names[id] ?? id);
  if (others.length === 0) return null;
  const people = peopleLabel(others);
  return { label: `${PREFIX}${people}`, subject: people };
}
function createRoomLabels(client, identity, log = () => {
}) {
  const known = /* @__PURE__ */ new Map();
  return async (roomId, signal, item) => {
    const cached = known.get(roomId);
    if (cached) return cached;
    const fromFacts = item ? roomLabelFromFacts(
      item,
      roomId,
      item.messages.map((m) => m.sender),
      identity
    ) : null;
    if (fromFacts) {
      known.set(roomId, fromFacts);
      return fromFacts;
    }
    try {
      const result = await client.callTool(
        "get_channel_details",
        { channel_id: roomId },
        { signal }
      );
      if (result.ok) {
        const label = roomLabelFrom(result.data, roomId, identity);
        known.set(roomId, label);
        return label;
      }
      log(
        `filament: no name for ${roomId} (${result.error?.message ?? "get_channel_details failed"})`
      );
    } catch (error) {
      log(`filament: no name for ${roomId} (${String(error)})`);
    }
    return roomId === identity.ccRoomId ? { label: `${PREFIX}${identity.principal}` } : { label: `${PREFIX}${roomId}` };
  };
}
export {
  createRoomLabels,
  roomLabelFrom,
  roomLabelFromFacts
};
