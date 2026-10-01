import type { ToolCallResult } from "./mcp-client.js";

export type OnboardingStatus = "finalized" | "not_finalized" | "auth_failed" | "transient";

export interface ResolvedIdentity {
  mxid: string;
  principal: string;
  ccRoomId?: string;
}

export interface OnboardingDecision {
  status: OnboardingStatus;
  identity?: ResolvedIdentity;
}

/** An agent without an owner, or `-32002` (reserved), is not finalized yet. */
export function classifyGetSelf(result: ToolCallResult): OnboardingDecision {
  if (result.ok) {
    const data = result.data;
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      const owner = d.owner;
      const ownerUserId =
        owner && typeof owner === "object" ? (owner as { user_id?: unknown }).user_id : undefined;
      const principal =
        (typeof ownerUserId === "string" && ownerUserId) ||
        (typeof d.owner_id === "string" ? d.owner_id : "");
      if (principal) {
        const mxid =
          (typeof d.mxid === "string" && d.mxid) ||
          (typeof d.user_id === "string" && d.user_id) ||
          "";
        const ccRoomId = typeof d.cc_room_id === "string" ? d.cc_room_id : undefined;
        return { status: "finalized", identity: { mxid, principal, ccRoomId } };
      }
    }
    return { status: "not_finalized" };
  }

  const code = result.error?.code;
  if (result.httpStatus === 401 || result.httpStatus === 403 || code === -32001) {
    return { status: "auth_failed" };
  }
  if (code === -32002) {
    return { status: "not_finalized" };
  }
  return { status: "transient" };
}

/** The server asks the agent to greet on connect through its `initialize` instructions. */
export function isFirstContact(instructions: string | null | undefined): boolean {
  return typeof instructions === "string" && instructions.includes("First contact:");
}
