import { openTable } from "./store.js";

/** The `get_self` identity of a channel account, so a restart does not re-onboard. */
export interface AgentIdentity {
  mxid: string;
  principal: string;
  /** The command-and-control (backchannel) room. */
  ccRoomId?: string;
  onboardedAt: number;
}

const identities = openTable<AgentIdentity>("identities");

export function loadIdentity(accountId: string): AgentIdentity | undefined {
  return identities.get(accountId);
}

export function saveIdentity(accountId: string, identity: AgentIdentity): void {
  identities.set(accountId, identity);
}
