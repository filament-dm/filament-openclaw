import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  authorizationCodeLogin,
  CLIENT_NAME,
  DEVICE_GRANT,
  deviceLogin,
  discover,
  login,
  LoginError,
  parseRedirect,
  pollDeviceToken,
  registerClient,
  SCOPE,
  startDeviceLogin,
  wellKnownUrls,
  withQuery,
  type Fetch,
} from "./oauth-login.js";

import { fakeHttp, ISSUER, MCP, server, type Answer } from "./testing/fake-oauth.js";

const quiet = () => {};
const noSleep = async () => {};

test("wellKnownUrls: the path-inserted location first, then the one under the base", () => {
  assert.deepEqual(wellKnownUrls(MCP, "oauth-protected-resource"), [
    "https://api.example/.well-known/oauth-protected-resource/mcp/agents",
    "https://api.example/mcp/agents/.well-known/oauth-protected-resource",
  ]);
  assert.deepEqual(wellKnownUrls("https://as.example/", "oauth-authorization-server"), [
    "https://as.example/.well-known/oauth-authorization-server",
  ]);
});

test("discover: reads the resource, the endpoints and the device grant", async () => {
  const http = fakeHttp(server());
  const meta = await discover(MCP, http.fetch);
  assert.deepEqual(meta, {
    resource: MCP,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    registrationEndpoint: `${ISSUER}/register`,
    deviceAuthorizationEndpoint: `${ISSUER}/device_authorization`,
  });
});

test("discover: falls back to the metadata under the base URL", async () => {
  const routes = server();
  const prm = routes["https://api.example/.well-known/oauth-protected-resource/mcp/agents"]!;
  delete routes["https://api.example/.well-known/oauth-protected-resource/mcp/agents"];
  routes[`${MCP}/.well-known/oauth-protected-resource`] = prm;
  const http = fakeHttp(routes);
  assert.equal((await discover(MCP, http.fetch)).tokenEndpoint, `${ISSUER}/token`);
  assert.deepEqual(
    http.calls.slice(0, 2).map((c) => c.url),
    [
      "https://api.example/.well-known/oauth-protected-resource/mcp/agents",
      `${MCP}/.well-known/oauth-protected-resource`,
    ],
  );
});

test("discover: a server without OAuth, or with incomplete settings, is refused", async () => {
  await assert.rejects(discover(MCP, fakeHttp({}).fetch), /does not offer OAuth/);
  const routes = server();
  const asUrl = "https://api.example/.well-known/oauth-authorization-server/mcp/agents/oauth";
  routes[asUrl] = [200, { authorization_endpoint: "x", registration_endpoint: "y" }];
  await assert.rejects(discover(MCP, fakeHttp(routes).fetch), /lack token_endpoint/);
});

test("discover: a reply that is not JSON, or no reply, is a LoginError", async () => {
  const routes: Record<string, Answer> = {
    "https://api.example/.well-known/oauth-protected-resource/mcp/agents": "<html>proxy</html>",
  };
  await assert.rejects(discover(MCP, fakeHttp(routes).fetch), (error: unknown) => {
    assert.ok(error instanceof LoginError);
    assert.match(error.message, /did not answer with JSON/);
    return true;
  });
  const down: Fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(discover(MCP, down), /Could not reach .*fetch failed/);
});

test("registerClient: a public device client named for OpenClaw", async () => {
  const http = fakeHttp(server());
  const meta = await discover(MCP, http.fetch);
  assert.equal(await registerClient(meta, null, http.fetch), "client-1");
  const register = http.calls.find((c) => c.url.endsWith("/register"))!;
  assert.equal(register.method, "POST");
  assert.deepEqual(register.body, {
    client_name: "OpenClaw (Filament plugin)",
    token_endpoint_auth_method: "none",
    grant_types: [DEVICE_GRANT],
    redirect_uris: [],
    response_types: [],
  });
  // The server types the agent from the client name.
  assert.match(CLIENT_NAME, /openclaw/i);
});

test("registerClient: a browser client registers its loopback redirect", async () => {
  const http = fakeHttp(server());
  const meta = await discover(MCP, http.fetch);
  await registerClient(meta, "http://127.0.0.1:5/callback", http.fetch);
  const register = http.calls.find((c) => c.url.endsWith("/register"))!;
  assert.deepEqual(register.body, {
    client_name: CLIENT_NAME,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    redirect_uris: ["http://127.0.0.1:5/callback"],
    response_types: ["code"],
  });
});

test("registerClient: a refusal or an answer without client_id is refused", async () => {
  for (const answer of [
    [400, { error: "invalid_client_metadata" }],
    [201, null],
  ] as Answer[]) {
    const routes = server();
    routes[`${ISSUER}/register`] = answer;
    const http = fakeHttp(routes);
    await assert.rejects(
      deviceLogin(await discover(MCP, http.fetch), {
        fetch: http.fetch,
        out: quiet,
        sleep: noSleep,
      }),
      /refused to register/,
    );
  }
});

test("deviceLogin: prints the link and code, waits out pending and slow_down", async () => {
  const http = fakeHttp(server(), [
    [400, { error: "authorization_pending" }],
    [400, { error: "slow_down" }],
    [
      200,
      {
        access_token: "fmcp_ok",
        token_type: "Bearer",
        scope: SCOPE,
        agent_user_id: "@a:x",
        principal_user_id: "@p:x",
      },
    ],
  ]);
  const slept: number[] = [];
  const lines: string[] = [];
  const token = await deviceLogin(await discover(MCP, http.fetch), {
    fetch: http.fetch,
    out: (line) => void lines.push(line),
    sleep: async (ms) => void slept.push(ms),
  });
  assert.equal(token, "fmcp_ok");
  assert.deepEqual(slept, [5000, 5000, 10000]);
  // The link and the code each stand on a line of their own.
  assert.ok(lines.includes(`${ISSUER}/device?user_code=BCDF-GHJK`));
  assert.ok(lines.includes("Code: BCDF-GHJK"));
  const device = http.calls.find((c) => c.url.endsWith("/device_authorization"))!;
  assert.deepEqual(device.form, { client_id: "client-1", scope: SCOPE, resource: MCP });
  const tokenForms = http.calls.filter((c) => c.url.endsWith("/token")).map((c) => c.form);
  assert.equal(tokenForms.length, 3);
  assert.deepEqual(tokenForms[2], {
    grant_type: DEVICE_GRANT,
    device_code: "dev_1",
    client_id: "client-1",
    resource: MCP,
  });
});

test("deviceLogin: the link expiring ends the wait", async () => {
  const http = fakeHttp(
    server(),
    Array.from({ length: 200 }, () => [400, { error: "authorization_pending" }] as Answer),
  );
  let clock = 0;
  await assert.rejects(
    deviceLogin(await discover(MCP, http.fetch), {
      fetch: http.fetch,
      out: quiet,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    }),
    /link expired/,
  );
  // 600 s at one poll every 5 s.
  assert.equal(http.calls.filter((c) => c.url.endsWith("/token")).length, 120);
});

test("deviceLogin: a declined, expired or failed grant is reported", async () => {
  const cases: Array<[Answer, RegExp]> = [
    [[400, { error: "access_denied" }], /declined \(access_denied\)/],
    [[400, { error: "expired_token" }], /expired \(expired_token\)/],
    [[400, { error: "invalid_grant", error_description: "bad code" }], /\(400\): bad code/],
    [[500, "oops"] as unknown as Answer, /did not issue a token \(500\)/],
  ];
  for (const [answer, message] of cases) {
    const http = fakeHttp(server(), [answer]);
    await assert.rejects(
      deviceLogin(await discover(MCP, http.fetch), {
        fetch: http.fetch,
        out: quiet,
        sleep: noSleep,
      }),
      (error: unknown) => error instanceof LoginError && message.test(error.message),
    );
  }
});

test("deviceLogin: a refused device authorization, or none offered, is reported", async () => {
  const routes = server();
  routes[`${ISSUER}/device_authorization`] = [400, { error: "invalid_scope" }];
  const http = fakeHttp(routes);
  await assert.rejects(
    deviceLogin(await discover(MCP, http.fetch), { fetch: http.fetch, out: quiet, sleep: noSleep }),
    /refused device sign-in \(400\)/,
  );
  const noDevice = fakeHttp(server(false));
  await assert.rejects(
    deviceLogin(await discover(MCP, noDevice.fetch), { fetch: noDevice.fetch, out: quiet }),
    /does not offer device sign-in/,
  );
});

test("login: auto takes the device grant when offered, else the browser", async () => {
  const device = fakeHttp(server(true), [[200, { access_token: "fmcp_device" }]]);
  assert.equal(
    await login(MCP, { fetch: device.fetch, out: quiet, sleep: noSleep }),
    "fmcp_device",
  );

  const browser = fakeHttp(server(false), [[200, { access_token: "fmcp_browser" }]]);
  const lines: string[] = [];
  const done = login(MCP, {
    fetch: browser.fetch,
    out: (line) => void lines.push(line),
    openBrowser: false,
    pasteInput: null,
  });
  const url = await waitForLine(lines, (line) => line.startsWith(`${ISSUER}/authorize`));
  const query = new URL(url).searchParams;
  await globalThis.fetch(`${query.get("redirect_uri")}?code=c1&state=${query.get("state")}`);
  assert.equal(await done, "fmcp_browser");
});

async function waitForLine(lines: string[], match: (line: string) => boolean): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const line = lines.find(match);
    if (line) return line;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no matching line in ${JSON.stringify(lines)}`);
}

test("authorizationCodeLogin: PKCE, state and resource, through the loopback redirect", async () => {
  const http = fakeHttp(server(), [[200, { access_token: "fmcp_browser" }]]);
  const lines: string[] = [];
  const done = authorizationCodeLogin(await discover(MCP, http.fetch), {
    fetch: http.fetch,
    out: (line) => void lines.push(line),
    openBrowser: false,
    pasteInput: null,
  });
  const url = await waitForLine(lines, (line) => line.startsWith(`${ISSUER}/authorize`));
  const query = new URL(url).searchParams;
  const redirectUri = query.get("redirect_uri")!;
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  // A browser's stray request, or a forged state, neither ends nor spoils the login.
  const origin = redirectUri.replace(/\/callback$/, "");
  assert.equal((await globalThis.fetch(`${origin}/favicon.ico`)).status, 404);
  assert.equal((await globalThis.fetch(`${redirectUri}?code=evil&state=nope`)).status, 404);
  const landed = await globalThis.fetch(`${redirectUri}?code=c1&state=${query.get("state")}`);
  assert.equal(landed.status, 200);
  assert.equal(await done, "fmcp_browser");

  assert.equal(query.get("response_type"), "code");
  assert.equal(query.get("client_id"), "client-1");
  assert.equal(query.get("scope"), SCOPE);
  assert.equal(query.get("resource"), MCP);
  assert.equal(query.get("code_challenge_method"), "S256");
  const form = http.calls.find((c) => c.url.endsWith("/token"))!.form!;
  const challenge = createHash("sha256").update(form.code_verifier!).digest("base64url");
  assert.equal(challenge, query.get("code_challenge"));
  assert.deepEqual(
    { ...form, code_verifier: "-" },
    {
      grant_type: "authorization_code",
      code: "c1",
      redirect_uri: redirectUri,
      client_id: "client-1",
      code_verifier: "-",
      resource: MCP,
    },
  );
});

test("authorizationCodeLogin: a redirect pasted at the terminal works like the callback", async () => {
  const http = fakeHttp(server(), [[200, { access_token: "fmcp_pasted" }]]);
  const lines: string[] = [];
  const stdin = new PassThrough();
  const done = authorizationCodeLogin(await discover(MCP, http.fetch), {
    fetch: http.fetch,
    out: (line) => void lines.push(line),
    openBrowser: false,
    pasteInput: stdin,
  });
  const url = await waitForLine(lines, (line) => line.startsWith(`${ISSUER}/authorize`));
  const query = new URL(url).searchParams;
  stdin.write("not a redirect\n");
  stdin.write(`${query.get("redirect_uri")}?code=c2&state=${query.get("state")}\n`);
  assert.equal(await done, "fmcp_pasted");
  assert.equal(http.calls.find((c) => c.url.endsWith("/token"))!.form!.code, "c2");
});

test("authorizationCodeLogin: a refusal, a stray state or a timeout is a LoginError", async () => {
  const run = async (paste: (query: URLSearchParams) => string, timeoutMs = 5000) => {
    const http = fakeHttp(server(), [[200, { access_token: "fmcp_x" }]]);
    const lines: string[] = [];
    const stdin = new PassThrough();
    const done = authorizationCodeLogin(await discover(MCP, http.fetch), {
      fetch: http.fetch,
      out: (line) => void lines.push(line),
      openBrowser: false,
      pasteInput: stdin,
      timeoutMs,
    });
    const url = await waitForLine(lines, (line) => line.startsWith(`${ISSUER}/authorize`));
    const line = paste(new URL(url).searchParams);
    if (line) stdin.write(`${line}\n`);
    return done;
  };
  await assert.rejects(
    run(() => "error=access_denied&error_description=Owner%20said%20no"),
    /refused: Owner said no/,
  );
  await assert.rejects(
    run(() => "code=c&state=other"),
    /different request/,
  );
  await assert.rejects(
    run(() => "", 50),
    /timed out/,
  );
});

test("parseRedirect: a full address or a bare query", () => {
  assert.deepEqual(parseRedirect("http://127.0.0.1:5/callback?code=a&state=b\n"), {
    code: "a",
    state: "b",
  });
  assert.deepEqual(parseRedirect("code=a&state=b"), { code: "a", state: "b" });
  assert.deepEqual(parseRedirect("/callback?code=a#frag"), { code: "a" });
});

test("withQuery: keeps a query the endpoint already has", () => {
  const url = withQuery("https://as.example/authorize?tenant=a", { state: "s" });
  assert.deepEqual(Object.fromEntries(new URL(url).searchParams), { tenant: "a", state: "s" });
});

test("startDeviceLogin / pollDeviceToken: the code outlives the process that asked for it", async () => {
  const http = fakeHttp(server(), [[200, { access_token: "fmcp_later" }]]);
  const lines: string[] = [];
  const auth = await startDeviceLogin(await discover(MCP, http.fetch), {
    fetch: http.fetch,
    out: (line) => void lines.push(line),
    now: () => 1_000,
  });
  assert.deepEqual(auth, {
    tokenEndpoint: `${ISSUER}/token`,
    resource: MCP,
    clientId: "client-1",
    deviceCode: "dev_1",
    interval: 5,
    expiresAt: 601_000,
  });
  assert.deepEqual(lines.slice(-2), [`${ISSUER}/device?user_code=BCDF-GHJK`, "Code: BCDF-GHJK"]);
  // Redeemed from the stored fields alone, as the gateway does.
  const later = fakeHttp({}, [[200, { access_token: "fmcp_later" }]]);
  assert.equal(
    await pollDeviceToken(auth, { fetch: later.fetch, sleep: noSleep, now: () => 2_000 }),
    "fmcp_later",
  );
});

test("pollDeviceToken: an unreachable server ends the foreground wait", async () => {
  const http = fakeHttp({}, [new TypeError("fetch failed")]);
  const auth = {
    tokenEndpoint: `${ISSUER}/token`,
    resource: MCP,
    clientId: "c",
    deviceCode: "d",
    interval: 1,
    expiresAt: Date.now() + 60_000,
  };
  await assert.rejects(
    pollDeviceToken(auth, { fetch: http.fetch, sleep: noSleep }),
    (error: unknown) =>
      error instanceof LoginError &&
      error.reason === "transient" &&
      /Could not reach/.test(error.message),
  );
});
