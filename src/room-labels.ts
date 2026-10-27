/**
 * Human names for the OpenClaw sessions Filament rooms land in. OpenClaw titles a session by its
 * inbound `ConversationLabel` (and a group's by `GroupSubject`); a raw room id there reads as
 * "!StblYfTaMSOBkpLZNJ:filament.dm". The backchannel is named for the owner, a named channel for
 * its name, and a DM or unnamed room for the people in it: from the room facts a poll_work item
 * carries (filament-dm/synapse#1156), or else from `get_channel_details`.
 */
import { asRecord } from "./accounts.js";
import type { ToolCallResult } from "./mcp-client.js";
import type { ResolvedIdentity } from "./onboarding-core.js";
import type { WorkItem } from "./work-item.js";

export interface RoomLabel {
  /** The session's title: "Filament · <who or what>". */
  label: string;
  /** The room's own name, or its people, for a group session's subject. */
  subject?: string;
}

export interface RoomLabelClient {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<ToolCallResult>;
}

const PREFIX = "Filament · ";

interface Member {
  mxid: string;
  name: string;
}

function membersOf(details: Record<string, unknown>): Member[] {
  const raw = Array.isArray(details.members) ? details.members : [];
  return raw.flatMap((entry) => {
    const member = asRecord(entry);
    if (typeof member.mxid !== "string" || !member.mxid) return [];
    const display = typeof member.display_name === "string" ? member.display_name.trim() : "";
    return [{ mxid: member.mxid, name: display || member.mxid }];
  });
}

/** The label for a room, from its `get_channel_details` result. */
export function roomLabelFrom(
  details: unknown,
  roomId: string,
  identity: Pick<ResolvedIdentity, "mxid" | "principal" | "ccRoomId">,
): RoomLabel {
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

function peopleLabel(names: string[]): string {
  return names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
}

/**
 * The label for a room from an item's own room facts, or null when the item has none (an older
 * server) or they don't name it: the owner absent from a backchannel item, nobody but the agent.
 */
export function roomLabelFromFacts(
  facts: Pick<WorkItem, "channel_name" | "sender_names">,
  roomId: string,
  senders: readonly string[],
  identity: Pick<ResolvedIdentity, "mxid" | "principal" | "ccRoomId">,
): RoomLabel | null {
  const names = facts.sender_names;
  if (!names) return null;
  if (roomId === identity.ccRoomId) {
    const owner = names[identity.principal];
    return owner ? { label: `${PREFIX}${owner}` } : null;
  }
  const name = facts.channel_name;
  if (name && name !== roomId) return { label: `${PREFIX}${name}`, subject: name };
  const others = [...new Set(senders)]
    .filter((id) => id !== identity.mxid)
    .map((id) => names[id] ?? id);
  if (others.length === 0) return null;
  const people = peopleLabel(others);
  return { label: `${PREFIX}${people}`, subject: people };
}

/**
 * Labels by room for one connection, worked out once each: from the first item's room facts
 * when it carries them, else looked up. A failed lookup labels the room by its
 * id and is tried again next time.
 */
export function createRoomLabels(
  client: RoomLabelClient,
  identity: Pick<ResolvedIdentity, "mxid" | "principal" | "ccRoomId">,
  log: (message: string) => void = () => {},
): (
  roomId: string,
  signal?: AbortSignal,
  item?: Pick<WorkItem, "channel_name" | "sender_names" | "messages">,
) => Promise<RoomLabel> {
  const known = new Map<string, RoomLabel>();
  return async (roomId, signal, item) => {
    const cached = known.get(roomId);
    if (cached) return cached;
    const fromFacts = item
      ? roomLabelFromFacts(
          item,
          roomId,
          item.messages.map((m) => m.sender),
          identity,
        )
      : null;
    if (fromFacts) {
      known.set(roomId, fromFacts);
      return fromFacts;
    }
    try {
      const result = await client.callTool(
        "get_channel_details",
        { channel_id: roomId },
        { signal },
      );
      if (result.ok) {
        const label = roomLabelFrom(result.data, roomId, identity);
        known.set(roomId, label);
        return label;
      }
      log(
        `filament: no name for ${roomId} (${result.error?.message ?? "get_channel_details failed"})`,
      );
    } catch (error) {
      log(`filament: no name for ${roomId} (${String(error)})`);
    }
    return roomId === identity.ccRoomId
      ? { label: `${PREFIX}${identity.principal}` }
      : { label: `${PREFIX}${roomId}` };
  };
}
