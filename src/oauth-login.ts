/**
 * Signs an OpenClaw agent in to Filament with MCP OAuth: the device grant (RFC 8628) when the
 * server offers it, else authorization code + PKCE with a loopback callback. The token it returns
 * is the agent's `fmcp_` bearer, the same credential a connect token is. A port of the Hermes
 * plugin's `oauth_login.py`.
 *
 * Filament infers the agent type from `client_name`: the server binds the owner's newest pending
 * OpenClaw reservation to a client whose name matches /openclaw/i, so the name must keep it.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";

export const SCOPE = "filament:agent:control";
export const CLIENT_NAME = "OpenClaw (Filament plugin)";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const HTTP_TIMEOUT_MS = 20_000;

/** A login step failed; the message is fit to show the owner. */
export class LoginError extends Error {
  override name = "LoginError";
}

export interface ServerMetadata {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  deviceAuthorizationEndpoint?: string;
}

export type Fetch = typeof fetch;

/** Each line is written out before the promise settles: the caller may be a file being tailed. */
export type Out = (line: string) => void | Promise<void>;

interface HttpAnswer {
  status: number;
  doc: unknown;
}

async function request(
  fetchImpl: Fetch,
  url: string,
  opts: { form?: Record<string, string>; body?: unknown } = {},
): Promise<HttpAnswer> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;
  if (opts.form !== undefined) {
    body = new URLSearchParams(opts.form).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(doc: Record<string, unknown>, key: string): string | undefined {
  const value = doc[key];
  return typeof value === "string" && value ? value : undefined;
}

/** Where RFC 8414 / 9728 metadata for `base` may live, most specific first. */
export function wellKnownUrls(base: string, name: string): string[] {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  const urls = [
    `${url.origin}/.well-known/${name}${path}`,
    `${base.replace(/\/+$/, "")}/.well-known/${name}`,
  ];
  return [...new Set(urls)];
}

async function firstDocument(
  fetchImpl: Fetch,
  urls: string[],
): Promise<Record<string, unknown> | null> {
  for (const url of urls) {
    const { status, doc } = await request(fetchImpl, url);
    if (status === 200 && isRecord(doc)) return doc;
  }
  return null;
}

export async function discover(mcpUrl: string, fetchImpl: Fetch = fetch): Promise<ServerMetadata> {
  const prm = await firstDocument(fetchImpl, wellKnownUrls(mcpUrl, "oauth-protected-resource"));
  const servers = prm?.authorization_servers;
  const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : undefined;
  if (!prm || !issuer) throw new LoginError(`${mcpUrl} does not offer OAuth sign-in.`);
  const meta = await firstDocument(fetchImpl, wellKnownUrls(issuer, "oauth-authorization-server"));
  if (!meta) throw new LoginError(`Could not read the sign-in settings of ${issuer}.`);
  const required = (key: string): string => {
    const value = stringField(meta, key);
    if (!value) throw new LoginError(`Filament's sign-in settings lack ${key}.`);
    return value;
  };
  return {
    resource: stringField(prm, "resource") ?? mcpUrl,
    authorizationEndpoint: required("authorization_endpoint"),
    tokenEndpoint: required("token_endpoint"),
    registrationEndpoint: required("registration_endpoint"),
    deviceAuthorizationEndpoint: stringField(meta, "device_authorization_endpoint"),
  };
}

/** A public client: the device grant with no redirect, or a code grant to `redirectUri`. */
export async function registerClient(
  meta: ServerMetadata,
  redirectUri: string | null,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const body: Record<string, unknown> = {
    client_name: CLIENT_NAME,
    token_endpoint_auth_method: "none",
    ...(redirectUri === null
      ? { grant_types: [DEVICE_GRANT], redirect_uris: [], response_types: [] }
      : {
          grant_types: ["authorization_code"],
          redirect_uris: [redirectUri],
          response_types: ["code"],
        }),
  };
  const { status, doc } = await request(fetchImpl, meta.registrationEndpoint, { body });
  const clientId = isRecord(doc) ? doc.client_id : undefined;
  if (
    (status !== 200 && status !== 201) ||
    (typeof clientId !== "string" && typeof clientId !== "number")
  ) {
    throw new LoginError(`Filament refused to register this agent (${status}).`);
  }
  return String(clientId);
}

/** `url` with `params` added to whatever query it already has. */
export function withQuery(url: string, params: Record<string, string>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) parsed.searchParams.append(key, value);
  return parsed.toString();
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** The query of a pasted redirect address (or a bare `code=...` query). */
export function parseRedirect(text: string): Record<string, string> {
  const trimmed = text.trim();
  const query = trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?") + 1) : trimmed;
  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query.split("#")[0])) {
    if (!(key in result) && value) result[key] = value;
  }
  return result;
}

function exchange(
  fetchImpl: Fetch,
  meta: ServerMetadata,
  form: Record<string, string>,
): Promise<HttpAnswer> {
  return request(fetchImpl, meta.tokenEndpoint, { form: { ...form, resource: meta.resource } });
}

function tokenFrom({ status, doc }: HttpAnswer): string {
  if (status === 200 && isRecord(doc)) {
    const token = stringField(doc, "access_token");
    if (token) return token;
  }
  const error = isRecord(doc) ? stringField(doc, "error") : undefined;
  if (error === "access_denied") throw new LoginError("Sign-in was declined (access_denied).");
  if (error === "expired_token") {
    throw new LoginError("The sign-in link expired (expired_token). Run the login again.");
  }
  const detail = isRecord(doc)
    ? (stringField(doc, "error_description") ?? error ?? JSON.stringify(doc))
    : String(doc);
  throw new LoginError(`Filament did not issue a token (${status}): ${detail}`);
}

export interface DeviceLoginOptions {
  fetch?: Fetch;
  out?: Out;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function deviceLogin(
  meta: ServerMetadata,
  opts: DeviceLoginOptions = {},
): Promise<string> {
  const fetchImpl = opts.fetch ?? fetch;
  const out = opts.out ?? consoleOut;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  if (!meta.deviceAuthorizationEndpoint) {
    throw new LoginError("Filament does not offer device sign-in.");
  }
  const clientId = await registerClient(meta, null, fetchImpl);
  const { status, doc } = await request(fetchImpl, meta.deviceAuthorizationEndpoint, {
    form: { client_id: clientId, scope: SCOPE, resource: meta.resource },
  });
  const deviceCode = isRecord(doc) ? stringField(doc, "device_code") : undefined;
  const userCode = isRecord(doc) ? stringField(doc, "user_code") : undefined;
  const verificationUri = isRecord(doc) ? stringField(doc, "verification_uri") : undefined;
  if (status !== 200 || !isRecord(doc) || !deviceCode || !userCode || !verificationUri) {
    throw new LoginError(`Filament refused device sign-in (${status}).`);
  }
  const link = stringField(doc, "verification_uri_complete") ?? verificationUri;
  await out("To connect this agent, open this link on any device signed in to Filament:");
  await out(link);
  await out(`Code: ${userCode}`);
  await out("Waiting for approval ...");
  let intervalMs = secondsField(doc.interval, 5) * 1000;
  const deadline = now() + secondsField(doc.expires_in, 600) * 1000;
  while (now() < deadline) {
    await sleep(intervalMs);
    const answer = await exchange(fetchImpl, meta, {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: clientId,
    });
    const error = isRecord(answer.doc) ? answer.doc.error : undefined;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    return tokenFrom(answer);
  }
  throw new LoginError("The sign-in link expired. Run the login again.");
}

function secondsField(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The loopback redirect for one login: only `/callback` with this state counts, once. */
function startCallbackServer(): Promise<{
  redirectUri: string;
  setState: (state: string) => void;
  result: Promise<Record<string, string>>;
  close: () => void;
}> {
  let state = "";
  let settled = false;
  let deliver: (got: Record<string, string>) => void = () => {};
  const result = new Promise<Record<string, string>>((resolve) => (deliver = resolve));
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    const got = parseRedirect(req.url ?? "");
    // A browser's stray request for / or /favicon.ico must not end or overwrite the login.
    if (path !== "/callback" || !state || got.state !== state || settled) {
      res.writeHead(404).end();
      return;
    }
    settled = true;
    const ok = "code" in got;
    res.writeHead(ok ? 200 : 400, {
      "Content-Type": "text/html; charset=utf-8",
      Connection: "close",
    });
    res.end(
      ok
        ? "<p>Signed in to Filament. You can close this tab.</p>"
        : "<p>Filament sign-in did not finish. Go back to the terminal.</p>",
    );
    deliver(got);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        setState: (value) => (state = value),
        result,
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

function openInBrowser(url: string): void {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const child = spawn(command!, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser here: the printed link is the way in.
  }
}

/** A redirect address pasted at the terminal, for a browser on another machine. */
function pastedRedirect(input: NodeJS.ReadableStream): {
  result: Promise<Record<string, string>>;
  close: () => void;
} {
  const lines = createInterface({ input });
  const result = new Promise<Record<string, string>>((resolve) => {
    lines.on("line", (line) => {
      const pasted = parseRedirect(line);
      if ("code" in pasted || "error" in pasted) resolve(pasted);
    });
  });
  return { result, close: () => lines.close() };
}

export interface BrowserLoginOptions {
  fetch?: Fetch;
  out?: Out;
  openBrowser?: boolean;
  timeoutMs?: number;
  /** Where a pasted redirect is read from; by default stdin when it is a terminal. */
  pasteInput?: NodeJS.ReadableStream | null;
}

export async function authorizationCodeLogin(
  meta: ServerMetadata,
  opts: BrowserLoginOptions = {},
): Promise<string> {
  const fetchImpl = opts.fetch ?? fetch;
  const out = opts.out ?? consoleOut;
  const pasteInput =
    opts.pasteInput !== undefined ? opts.pasteInput : process.stdin.isTTY ? process.stdin : null;
  const callback = await startCallbackServer();
  const paste = pasteInput ? pastedRedirect(pasteInput) : null;
  let timer: NodeJS.Timeout | undefined;
  let clientId: string;
  let verifier: string;
  let state: string;
  let got: Record<string, string>;
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
      resource: meta.resource,
    });
    await out("Sign in to Filament to connect this agent:");
    await out(url);
    await out(
      "If the browser is on another machine, sign in there, then paste the address it ends up on (it starts with http://127.0.0.1) here.",
    );
    if (opts.openBrowser ?? true) openInBrowser(url);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new LoginError("Sign-in timed out. Run the login again.")),
        opts.timeoutMs ?? 600_000,
      );
    });
    got = await Promise.race([callback.result, timeout, ...(paste ? [paste.result] : [])]);
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
      code_verifier: verifier,
    }),
  );
}

export type LoginFlow = "auto" | "device" | "browser";

export interface LoginOptions extends DeviceLoginOptions, BrowserLoginOptions {
  flow?: LoginFlow;
}

/**
 * Runs the sign-in and returns the agent's `fmcp_` token. `auto` takes the device grant when the
 * server offers it, otherwise the browser.
 */
export async function login(mcpUrl: string, opts: LoginOptions = {}): Promise<string> {
  const meta = await discover(mcpUrl, opts.fetch ?? fetch);
  const flow = opts.flow ?? "auto";
  if (flow === "device" || (flow === "auto" && meta.deviceAuthorizationEndpoint)) {
    return deviceLogin(meta, opts);
  }
  return authorizationCodeLogin(meta, opts);
}

/** Resolves once the line is handed to the OS, so a tailed output file shows it right away. */
export const consoleOut: Out = (line) =>
  new Promise<void>((resolve) => {
    process.stdout.write(`${line}\n`, () => resolve());
  });
