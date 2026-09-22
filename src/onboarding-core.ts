/**
 * Pure onboarding decision logic — no OpenClaw/eneris imports, so it can be
 * unit-tested without a gateway (mirrors the `conformance-core.ts` split).
 */
import type { ToolCallResult } from "./mcp-client.js";

export type OnboardingStatus = "finalized" | "not_finalized" | "auth_failed" | "transient";

/** The identity fields learned from a finalized `get_self` (sans timestamp). */
export interface ResolvedIdentity {
  mxid: string;
  principal: string;
  ccRoomId?: string;
}

export interface OnboardingDecision {
  status: OnboardingStatus;
  /** Present only when status is "finalized". */
  identity?: ResolvedIdentity;
}

/**
 * Classify a `get_self` result (mirrors Hermes' finalization logic, resilient
 * to the exact error code):
 *   - success with an owner   -> finalized (extract principal + backchannel)
 *   - success without owner    -> not finalized yet
 *   - -32002 (reserved)        -> not finalized yet
 *   - -32001 / HTTP 401 / 403  -> auth failed (token rejected; stop)
 *   - anything else            -> transient (retry)
 */
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
