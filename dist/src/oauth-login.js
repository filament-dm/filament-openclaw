import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
const SCOPE = "filament:agent:control";
const CLIENT_NAME = "OpenClaw (Filament plugin)";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const HTTP_TIMEOUT_MS = 2e4;
class LoginError extends Error {
  name = "LoginError";
}
async function request(fetchImpl, url, opts = {}) {
  const headers = { Accept: "application/json" };
  let body;
  if (opts.form !== void 0) {
    body = new URLSearchParams(opts.form).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (opts.body !== void 0) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method: body === void 0 ? "GET" : "POST",
      headers,
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    text = await response.text();
  } catch (error) {
    throw new LoginError(`Could not reach ${url}: ${errorMessage(error)}`);
  }
  try {
    return { status: response.status, doc: JSON.parse(text || "null") };
  } catch {
    if (response.ok) throw new LoginError(`${url} did not answer with JSON.`);
    return { status: response.status, doc: { error: text.slice(0, 200) } };
  }
}
function errorMessage(error) {
  if (error instanceof Error) {
    const cause = error.cause;
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(doc, key) {
  const value = doc[key];
  return typeof value === "string" && value ? value : void 0;
}
function wellKnownUrls(base, name) {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  const urls = [
    `${url.origin}/.well-known/${name}${path}`,
    `${base.replace(/\/+$/, "")}/.well-known/${name}`
  ];
  return [...new Set(urls)];
}
async function firstDocument(fetchImpl, urls) {
  for (const url of urls) {
    const { status, doc } = await request(fetchImpl, url);
    if (status === 200 && isRecord(doc)) return doc;
  }
  return null;
}
async function discover(mcpUrl, fetchImpl = fetch) {
  const prm = await firstDocument(fetchImpl, wellKnownUrls(mcpUrl, "oauth-protected-resource"));
  const servers = prm?.authorization_servers;
  const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : void 0;
  if (!prm || !issuer) throw new LoginError(`${mcpUrl} does not offer OAuth sign-in.`);
  const meta = await firstDocument(fetchImpl, wellKnownUrls(issuer, "oauth-authorization-server"));
  if (!meta) throw new LoginError(`Could not read the sign-in settings of ${issuer}.`);
  const required = (key) => {
    const value = stringField(meta, key);
    if (!value) throw new LoginError(`Filament's sign-in settings lack ${key}.`);
    return value;
  };
  return {
    resource: stringField(prm, "resource") ?? mcpUrl,
    authorizationEndpoint: required("authorization_endpoint"),
    tokenEndpoint: required("token_endpoint"),
    registrationEndpoint: required("registration_endpoint"),
    deviceAuthorizationEndpoint: stringField(meta, "device_authorization_endpoint")
  };
}
async function registerClient(meta, redirectUri, fetchImpl = fetch) {
  const body = {
    client_name: CLIENT_NAME,
    token_endpoint_auth_method: "none",
    ...redirectUri === null ? { grant_types: [DEVICE_GRANT], redirect_uris: [], response_types: [] } : {
      grant_types: ["authorization_code"],
      redirect_uris: [redirectUri],
      response_types: ["code"]
    }
  };
  const { status, doc } = await request(fetchImpl, meta.registrationEndpoint, { body });
  const clientId = isRecord(doc) ? doc.client_id : void 0;
  if (status !== 200 && status !== 201 || typeof clientId !== "string" && typeof clientId !== "number") {
    throw new LoginError(`Filament refused to register this agent (${status}).`);
  }
  return String(clientId);
}
function withQuery(url, params) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) parsed.searchParams.append(key, value);
  return parsed.toString();
}
function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
function parseRedirect(text) {
  const trimmed = text.trim();
  const query = trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?") + 1) : trimmed;
  const result = {};
  for (const [key, value] of new URLSearchParams(query.split("#")[0])) {
    if (!(key in result) && value) result[key] = value;
  }
  return result;
}
function exchange(fetchImpl, meta, form) {
  return request(fetchImpl, meta.tokenEndpoint, { form: { ...form, resource: meta.resource } });
}
function tokenFrom({ status, doc }) {
  if (status === 200 && isRecord(doc)) {
    const token = stringField(doc, "access_token");
    if (token) return token;
  }
  const error = isRecord(doc) ? stringField(doc, "error") : void 0;
  if (error === "access_denied") throw new LoginError("Sign-in was declined (access_denied).");
  if (error === "expired_token") {
    throw new LoginError("The sign-in link expired (expired_token). Run the login again.");
  }
  const detail = isRecord(doc) ? stringField(doc, "error_description") ?? error ?? JSON.stringify(doc) : String(doc);
  throw new LoginError(`Filament did not issue a token (${status}): ${detail}`);
}
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function deviceLogin(meta, opts = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const out = opts.out ?? consoleOut;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  if (!meta.deviceAuthorizationEndpoint) {
    throw new LoginError("Filament does not offer device sign-in.");
  }
  const clientId = await registerClient(meta, null, fetchImpl);
  const { status, doc } = await request(fetchImpl, meta.deviceAuthorizationEndpoint, {
    form: { client_id: clientId, scope: SCOPE, resource: meta.resource }
  });
  const deviceCode = isRecord(doc) ? stringField(doc, "device_code") : void 0;
  const userCode = isRecord(doc) ? stringField(doc, "user_code") : void 0;
  const verificationUri = isRecord(doc) ? stringField(doc, "verification_uri") : void 0;
  if (status !== 200 || !isRecord(doc) || !deviceCode || !userCode || !verificationUri) {
    throw new LoginError(`Filament refused device sign-in (${status}).`);
  }
  const link = stringField(doc, "verification_uri_complete") ?? verificationUri;
  await out("To connect this agent, open this link on any device signed in to Filament:");
  await out(link);
  await out(`Code: ${userCode}`);
  await out("Waiting for approval ...");
  let intervalMs = secondsField(doc.interval, 5) * 1e3;
  const deadline = now() + secondsField(doc.expires_in, 600) * 1e3;
  while (now() < deadline) {
    await sleep(intervalMs);
    const answer = await exchange(fetchImpl, meta, {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: clientId
    });
    const error = isRecord(answer.doc) ? answer.doc.error : void 0;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += 5e3;
      continue;
    }
    return tokenFrom(answer);
  }
  throw new LoginError("The sign-in link expired. Run the login again.");
}
function secondsField(raw, fallback) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function startCallbackServer() {
  let state = "";
  let settled = false;
  let deliver = () => {
  };
  const result = new Promise((resolve) => deliver = resolve);
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const got = parseRedirect(req.url ?? "");
    if (path !== "/callback" || !state || got.state !== state || settled) {
      res.writeHead(404).end();
      return;
    }
    settled = true;
    const ok = "code" in got;
    res.writeHead(ok ? 200 : 400, {
      "Content-Type": "text/html; charset=utf-8",
      Connection: "close"
    });
    res.end(
      ok ? "<p>Signed in to Filament. You can close this tab.</p>" : "<p>Filament sign-in did not finish. Go back to the terminal.</p>"
    );
    deliver(got);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        setState: (value) => state = value,
        result,
        close: () => {
          server.close();
          server.closeAllConnections();
        }
      });
    });
  });
}
function openInBrowser(url) {
  const [command, ...args] = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}
function pastedRedirect(input) {
  const lines = createInterface({ input });
  const result = new Promise((resolve) => {
    lines.on("line", (line) => {
      const pasted = parseRedirect(line);
      if ("code" in pasted || "error" in pasted) resolve(pasted);
    });
  });
  return { result, close: () => lines.close() };
}
async function authorizationCodeLogin(meta, opts = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const out = opts.out ?? consoleOut;
  const pasteInput = opts.pasteInput !== void 0 ? opts.pasteInput : process.stdin.isTTY ? process.stdin : null;
  const callback = await startCallbackServer();
  const paste = pasteInput ? pastedRedirect(pasteInput) : null;
  let timer;
  let clientId;
  let verifier;
  let state;
  let got;
  try {
    clientId = await registerClient(meta, callback.redirectUri, fetchImpl);
    const pkce = pkcePair();
    verifier = pkce.verifier;
    state = randomBytes(16).toString("base64url");
    callback.setState(state);
    const url = withQuery(meta.authorizationEndpoint, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: callback.redirectUri,
      scope: SCOPE,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      resource: meta.resource
    });
    await out("Sign in to Filament to connect this agent:");
    await out(url);
    await out(
      "If the browser is on another machine, sign in there, then paste the address it ends up on (it starts with http://127.0.0.1) here."
    );
    if (opts.openBrowser ?? true) openInBrowser(url);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new LoginError("Sign-in timed out. Run the login again.")),
        opts.timeoutMs ?? 6e5
      );
    });
    got = await Promise.race([callback.result, timeout, ...paste ? [paste.result] : []]);
  } finally {
    clearTimeout(timer);
    callback.close();
    paste?.close();
  }
  if (got.error) {
    throw new LoginError(`Sign-in was refused: ${got.error_description ?? got.error}`);
  }
  if (got.state !== state) {
    throw new LoginError("Sign-in answered a different request. Run the login again.");
  }
  if (!got.code)
    throw new LoginError("Sign-in returned no authorization code. Run the login again.");
  return tokenFrom(
    await exchange(fetchImpl, meta, {
      grant_type: "authorization_code",
      code: got.code,
      redirect_uri: callback.redirectUri,
      client_id: clientId,
      code_verifier: verifier
    })
  );
}
async function login(mcpUrl, opts = {}) {
  const meta = await discover(mcpUrl, opts.fetch ?? fetch);
  const flow = opts.flow ?? "auto";
  if (flow === "device" || flow === "auto" && meta.deviceAuthorizationEndpoint) {
    return deviceLogin(meta, opts);
  }
  return authorizationCodeLogin(meta, opts);
}
const consoleOut = (line) => new Promise((resolve) => {
  process.stdout.write(`${line}
`, () => resolve());
});
export {
  CLIENT_NAME,
  DEVICE_GRANT,
  LoginError,
  SCOPE,
  authorizationCodeLogin,
  consoleOut,
  deviceLogin,
  discover,
  login,
  parseRedirect,
  pkcePair,
  registerClient,
  wellKnownUrls,
  withQuery
};
