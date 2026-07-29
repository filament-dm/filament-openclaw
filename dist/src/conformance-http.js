import { dispatchOp, manifest } from "./conformance-core.js";
const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 5e3;
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("request body timeout"));
    }, BODY_TIMEOUT_MS);
    req.on("data", (chunk) => {
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
function registerConformanceRoutes(api, deps) {
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
    }
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
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 200, {
          ok: false,
          error: { code: "internal", message: "invalid request body" }
        });
        return true;
      }
      const op = body && typeof body === "object" ? body.op : void 0;
      if (typeof op !== "string") {
        sendJson(res, 200, { ok: false, error: { code: "internal", message: "missing op" } });
        return true;
      }
      sendJson(res, 200, dispatchOp(op, deps));
      return true;
    }
  });
  api.logger?.info?.("filament-fcm: conformance control surface enabled");
}
export {
  registerConformanceRoutes
};
//# sourceMappingURL=conformance-http.js.map
