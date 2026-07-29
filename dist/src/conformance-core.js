import { createHash } from "node:crypto";
const PROTOCOL = "1";
const EXPECTED_PROJECT_ID = "filament-8ce44";
const OPS = ["fcm.token"];
function fingerprint(token) {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}
function manifest() {
  return { target: "openclaw", protocol: PROTOCOL, ops: [...OPS] };
}
function dispatchOp(op, deps) {
  switch (op) {
    case "fcm.token": {
      const snap = deps.getTokenSnapshot();
      if (!snap || !snap.token) {
        return {
          ok: false,
          error: {
            code: "no_cached_token",
            message: "Gateway holds no FCM registration token; agent is not onboarded/connected."
          }
        };
      }
      return {
        ok: true,
        result: {
          token_fingerprint: fingerprint(snap.token),
          project_id: snap.projectId,
          sender_id: snap.senderId,
          connected: snap.connected,
          source: snap.source
        }
      };
    }
    default:
      return {
        ok: false,
        error: { code: "unsupported_op", message: `unknown op ${JSON.stringify(op)}` }
      };
  }
}
export {
  EXPECTED_PROJECT_ID,
  OPS,
  PROTOCOL,
  dispatchOp,
  fingerprint,
  manifest
};
//# sourceMappingURL=conformance-core.js.map
