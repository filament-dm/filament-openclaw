/**
 * HTTP wiring for the conformance control surface. Registers two routes on the
 * gateway's own server via `api.registerHttpRoute` with `auth: "gateway"`, so
 * the gateway enforces its bearer token before our handlers run — no separate
 * port and no own HTTP server. The pure request/response logic lives in
 * `conformance-core.ts`; here we only read the body and marshal JSON.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { dispatchOp, manifest, type DispatchDeps } from "./conformance-core.js";

/** Minimal structural view of the plugin API we need (avoids type coupling). */
export interface ConformanceRouteApi {
  registerHttpRoute(params: {
    path: string;
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => Promise<boolean | void> | boolean | void;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
  }): void;
  logger?: { info?: (message: string) => void };
}

const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 5_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("request body timeout"));
    }, BODY_TIMEOUT_MS);
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        clearTimeout(timer);
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Register `GET /conformance/manifest` and `POST /conformance/op`. The op
 * endpoint always answers HTTP 200 with the envelope for application-level
 * outcomes; the gateway handles auth (401) before we run.
 */
export function registerConformanceRoutes(api: ConformanceRouteApi, deps: DispatchDeps): void {
  api.registerHttpRoute({
    path: "/conformance/manifest",
    auth: "gateway",
    match: "exact",
    handler: (req, res) => {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: { code: "method_not_allowed" } });
        return true;
      }
      sendJson(res, 200, manifest());
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/conformance/op",
    auth: "gateway",
    match: "exact",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: { code: "method_not_allowed" } });
        return true;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 200, {
          ok: false,
          error: { code: "internal", message: "invalid request body" },
        });
        return true;
      }
      const op = body && typeof body === "object" ? (body as { op?: unknown }).op : undefined;
      if (typeof op !== "string") {
        sendJson(res, 200, { ok: false, error: { code: "internal", message: "missing op" } });
        return true;
      }
      sendJson(res, 200, dispatchOp(op, deps));
      return true;
    },
  });

  api.logger?.info?.("filament-fcm: conformance control surface enabled");
}
