/**
 * Pure, transport-free core of the Filament conformance control surface.
 *
 * This module intentionally imports nothing from OpenClaw or @eneris — only
 * node:crypto — so its logic can be unit-tested without a gateway or network.
 * The HTTP wiring lives in `conformance-http.ts`; the token source is injected.
 *
 * The contract (paths, envelope, ops) matches `agent-plugin-conformance`'s
 * `spec/openapi.yaml`. Only the transport (base URL + auth) differs per target.
 */
import { createHash } from "node:crypto";

/** Protocol revision this target speaks (see the conformance spec). */
export const PROTOCOL = "1";

/** The Firebase project every Filament client registers against. */
export const EXPECTED_PROJECT_ID = "filament-8ce44";

/** Ops this target implements, advertised via the manifest. */
export const OPS = ["fcm.token"] as const;

/**
 * A non-secret fingerprint of an FCM token: `sha256(token)` truncated to 12
 * lowercase hex chars. Matches Hermes' `observability.fingerprint()` and the
 * spec's `^[0-9a-f]{12}$`. The raw token is never returned over the wire.
 */
export function fingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}

export interface ConformanceManifest {
  target: string;
  protocol: string;
  ops: string[];
}

/** GET /conformance/manifest body. */
export function manifest(): ConformanceManifest {
  return { target: "openclaw", protocol: PROTOCOL, ops: [...OPS] };
}

/** Current FCM token state, as seen by the op layer. */
export interface TokenSnapshot {
  token: string;
  projectId: string;
  senderId: string;
  /** Whether the MCS push receiver is currently connected (informational). */
  connected: boolean;
  source: "live" | "cache";
}

export interface OpError {
  code: "no_cached_token" | "unsupported_op" | "internal";
  message?: string;
}

export interface OpEnvelope {
  ok: boolean;
  result?: unknown;
  error?: OpError;
}

export interface DispatchDeps {
  /** Returns the current token snapshot, or null when nothing is cached. */
  getTokenSnapshot: () => TokenSnapshot | null;
}

/**
 * Dispatch a single conformance op to its result envelope. Application-level
 * outcomes (including `no_cached_token`) are returned as `ok:false` envelopes,
 * never thrown — the HTTP layer always answers 200 with the envelope.
 */
export function dispatchOp(op: string, deps: DispatchDeps): OpEnvelope {
  switch (op) {
    case "fcm.token": {
      const snap = deps.getTokenSnapshot();
      if (!snap || !snap.token) {
        return {
          ok: false,
          error: {
            code: "no_cached_token",
            message: "Gateway holds no FCM registration token; agent is not onboarded/connected.",
          },
        };
      }
      return {
        ok: true,
        result: {
          token_fingerprint: fingerprint(snap.token),
          project_id: snap.projectId,
          sender_id: snap.senderId,
          connected: snap.connected,
          source: snap.source,
        },
      };
    }
    default:
      return {
        ok: false,
        error: { code: "unsupported_op", message: `unknown op ${JSON.stringify(op)}` },
      };
  }
}
