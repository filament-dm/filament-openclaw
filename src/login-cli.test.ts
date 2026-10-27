import assert from "node:assert/strict";
import { test } from "node:test";

import { writeGatewayConfig, type CliResult } from "./config-write.js";
import {
  applyLogin,
  registerFilamentCli,
  resolveLoginAgent,
  resolveLoginUrl,
  runLogin,
  probeBearer,
  runStatus,
  type CliCommand,
  type ProbeResult,
  type LoginCommandOptions,
} from "./login-cli.js";
import { LoginError } from "./oauth-login.js";
import { tokenFingerprint, type SignInEnd } from "./state/sign-in.js";
import { fakeHttp, ISSUER, MCP, server } from "./testing/fake-oauth.js";

const PROD = "https://api.filament.dm/mcp/agents";
const DEV = "http://filament-dev.local:8448/mcp/agents";

function gateway(ids: string[], extra: Record<string, unknown> = {}) {
  return { agents: { entries: Object.fromEntries(ids.map((id) => [id, {}])) }, ...extra };
}

const nowhere = { cwd: "/elsewhere", home: "/home/me", realpath: (path: string) => path };

test("resolveLoginAgent: the named agent, else the only one", () => {
  assert.deepEqual(resolveLoginAgent(gateway(["main", "news"]), "News", nowhere), {
    agentId: "news",
    reason: "named with --agent",
  });
  assert.deepEqual(resolveLoginAgent(gateway(["writer"]), undefined, nowhere), {
    agentId: "writer",
    reason: "the gateway's only agent",
  });
  // No agents configured: OpenClaw's implicit `main`.
  assert.equal(resolveLoginAgent({}, undefined, nowhere).agentId, "main");
});

test("resolveLoginAgent: the agent whose workspace holds the current directory", () => {
  // A fresh onboarded config, plus a second agent that has no workspace of its own.
  const cfg = {
    agents: {
      defaults: { workspace: "~/.openclaw/workspace" },
      entries: {
        main: {
          name: "main",
          workspace: "/home/me/.openclaw/workspace",
          identity: { name: "main" },
        },
        news: { workspace: "/home/me/.openclaw/workspace-news" },
        quiet: {},
      },
    },
  };
  const at = (cwd: string) => ({ cwd, home: "/home/me", realpath: (path: string) => path });
  assert.deepEqual(resolveLoginAgent(cfg, undefined, at("/home/me/.openclaw/workspace-news")), {
    agentId: "news",
    reason: "its workspace is the current directory",
  });
  assert.deepEqual(resolveLoginAgent(cfg, undefined, at("/home/me/.openclaw/workspace-news/a/b")), {
    agentId: "news",
    reason: "the current directory is in its workspace",
  });
  // `quiet` falls back to the default workspace, which `main` also has: no answer from there.
  assert.throws(
    () => resolveLoginAgent(cfg, undefined, at("/home/me/.openclaw/workspace")),
    /^LoginError: Could not tell which OpenClaw agent to connect \(agents: main, news, quiet\); pass --agent <id>\.$/,
  );
  // --agent wins over the directory.
  assert.equal(
    resolveLoginAgent(cfg, "main", at("/home/me/.openclaw/workspace-news")).agentId,
    "main",
  );
  // A sibling whose name only starts like the workspace is outside it.
  assert.throws(() =>
    resolveLoginAgent(cfg, undefined, at("/home/me/.openclaw/workspace-newsroom")),
  );

  // The deepest workspace wins, and symlinked paths compare by their real path.
  const nested = gateway([], {
    agents: { entries: { outer: { workspace: "/w" }, inner: { workspace: "/w/inner" } } },
  });
  const links = {
    cwd: "/link/inner/x",
    home: "/h",
    realpath: (p: string) => p.replace(/^\/link/, "/w"),
  };
  assert.deepEqual(resolveLoginAgent(nested, undefined, links), {
    agentId: "inner",
    reason: "the current directory is in its workspace",
  });
});

test("resolveLoginAgent: an unknown, reserved, malformed or ambiguous agent is refused", () => {
  const cfg = gateway(["main", "news"]);
  assert.throws(
    () => resolveLoginAgent(cfg, undefined, nowhere),
    /Could not tell which OpenClaw agent to connect \(agents: main, news\); pass --agent <id>/,
  );
  assert.throws(
    () => resolveLoginAgent(cfg, "nope", nowhere),
    /no OpenClaw agent "nope" \(agents: main, news\)/,
  );
  assert.throws(() => resolveLoginAgent(cfg, "gateway", nowhere), LoginError);
  assert.throws(() => resolveLoginAgent(cfg, "bad id!", nowhere), /not a usable OpenClaw agent id/);
});

test("resolveLoginUrl: flag, env, the account's, the plugin's, production", () => {
  const cfg = {
    mcpUrl: "https://top/mcp/agents/",
    accounts: { main: { mcpUrl: "https://acct/x" } },
  };
  assert.equal(resolveLoginUrl(cfg, "main", `${DEV}/`, { FILAMENT_MCP_URL: "https://env/x" }), DEV);
  assert.equal(
    resolveLoginUrl(cfg, "main", undefined, { FILAMENT_MCP_URL: "https://env/x" }),
    "https://env/x",
  );
  assert.equal(resolveLoginUrl(cfg, "main", undefined, {}), "https://acct/x");
  assert.equal(resolveLoginUrl(cfg, "other", undefined, {}), "https://top/mcp/agents");
  assert.equal(resolveLoginUrl(undefined, "main", undefined, {}), PROD);
  // A bare server means its agents endpoint; any other path is taken as given.
  assert.equal(
    resolveLoginUrl({}, "main", "http://filament-dev.local:8448", {}),
    "http://filament-dev.local:8448/mcp/agents",
  );
  assert.equal(
    resolveLoginUrl({}, "main", undefined, { FILAMENT_MCP_URL: "https://staging.example/" }),
    "https://staging.example/mcp/agents",
  );
  assert.equal(resolveLoginUrl({}, "main", "https://x/custom/", {}), "https://x/custom");
  assert.throws(() => resolveLoginUrl({}, "main", "ftp://x", {}), /not a Filament MCP URL/);
  assert.throws(() => resolveLoginUrl({}, "main", "nope", {}), /not a Filament MCP URL/);
});

function draftOf(pluginConfig: Record<string, unknown>, bindings: unknown[] = []) {
  return {
    plugins: { entries: { "filament-openclaw": { config: pluginConfig } } },
    bindings,
  } as Record<string, unknown>;
}

const configOf = (draft: Record<string, unknown>) =>
  (draft as any).plugins.entries["filament-openclaw"].config;

test("applyLogin: account id = agent id, bound, replacing the agent's previous account", () => {
  const draft = draftOf(
    {
      accounts: {
        "pending-abc": { connectToken: "fmcp_old", pending: true },
        other: { connectToken: "fmcp_o" },
      },
    },
    [
      { agentId: "main", match: { channel: "filament", accountId: "pending-abc" } },
      { agentId: "other", match: { channel: "filament", accountId: "other" } },
      { agentId: "main", match: { channel: "slack" } },
    ],
  );
  assert.deepEqual(applyLogin(draft, "main", { connectToken: "fmcp_new" }, PROD), {
    displaced: ["pending-abc"],
  });
  assert.deepEqual(configOf(draft).accounts, {
    other: { connectToken: "fmcp_o" },
    main: { connectToken: "fmcp_new" },
  });
  assert.deepEqual(draft.bindings, [
    { agentId: "other", match: { channel: "filament", accountId: "other" } },
    { agentId: "main", match: { channel: "slack" } },
    { agentId: "main", match: { channel: "filament", accountId: "main" } },
  ]);
});

const PENDING = {
  deviceCode: "dev_1",
  clientId: "client-1",
  tokenEndpoint: `${ISSUER}/token`,
  resource: MCP,
  interval: 5,
  expiresAt: "2026-10-13T12:10:00.000Z",
};

test("applyLogin: a pending sign-in takes the old token's place, and a token ends it", () => {
  const draft = draftOf({ accounts: { main: { connectToken: "fmcp_old" } } });
  applyLogin(draft, "main", { pendingSignIn: PENDING }, PROD);
  assert.deepEqual(configOf(draft).accounts.main, { pendingSignIn: PENDING });
  applyLogin(draft, "main", { connectToken: "fmcp_new" }, PROD);
  assert.deepEqual(configOf(draft).accounts.main, { connectToken: "fmcp_new" });
});

test("applyLogin: a URL other than the plugin's is kept on the account, the plugin's is not", () => {
  const draft = draftOf({ accounts: { main: { connectToken: "fmcp_old", mcpUrl: DEV } } });
  applyLogin(draft, "main", { connectToken: "fmcp_a" }, DEV);
  assert.deepEqual(configOf(draft).accounts.main, { connectToken: "fmcp_a", mcpUrl: DEV });
  applyLogin(draft, "main", { connectToken: "fmcp_b" }, PROD);
  assert.deepEqual(configOf(draft).accounts.main, { connectToken: "fmcp_b" });

  const dev = draftOf({ mcpUrl: DEV });
  applyLogin(dev, "main", { connectToken: "fmcp_c" }, DEV);
  assert.deepEqual(configOf(dev).accounts.main, { connectToken: "fmcp_c" });
  applyLogin(dev, "main", { connectToken: "fmcp_d" }, PROD);
  assert.deepEqual(configOf(dev).accounts.main, { connectToken: "fmcp_d", mcpUrl: PROD });
});

function collect() {
  const out: string[] = [];
  const warn: string[] = [];
  return {
    out,
    warn,
    deps: { out: (l: string) => void out.push(l), warn: (l: string) => void warn.push(l) },
  };
}

/** `openclaw config get/patch` over an in-memory file. */
function fakeConfigCli(file: { pluginConfig: unknown; bindings: unknown }) {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const run = async (args: string[], stdin?: string): Promise<CliResult> => {
    calls.push({ args, stdin });
    const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: "" });
    if (args[1] === "get" && args[2] === "bindings") return ok(JSON.stringify(file.bindings));
    if (args[1] === "get") return ok(JSON.stringify(file.pluginConfig));
    return ok("");
  };
  const patch = () => JSON.parse(calls.find((c) => c.args[1] === "patch")!.stdin!);
  return {
    calls,
    patch,
    writeConfig: (mutate: (draft: Record<string, unknown>) => void) =>
      writeGatewayConfig(mutate, run),
  };
}

const T0 = Date.parse("2026-10-13T12:00:00.000Z");

test("runLogin: by default prints the link and code, hands the sign-in to the gateway, exits", async () => {
  const http = fakeHttp(server());
  const cli = fakeConfigCli({
    pluginConfig: { accounts: { "pending-abc": { connectToken: "fmcp_old", pending: true } } },
    bindings: [{ agentId: "main", match: { channel: "filament", accountId: "pending-abc" } }],
  });
  const io = collect();
  const code = await runLogin(
    { agent: "main" },
    {
      ...io.deps,
      gatewayConfig: gateway(["main", "news"]),
      env: { FILAMENT_MCP_URL: MCP },
      fetch: http.fetch,
      now: () => T0,
      sleep: async () => assert.fail("the CLI does not poll"),
      writeConfig: cli.writeConfig,
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(io.out, [
    `Connecting OpenClaw agent "main" (named with --agent).`,
    `Signing in to Filament at ${MCP} ...`,
    "To connect this agent, open this link on any device signed in to Filament:",
    `${ISSUER}/device?user_code=BCDF-GHJK`,
    "Code: BCDF-GHJK",
    "The link expires in 10 minutes.",
    "Approve the link above. This gateway finishes the sign-in by itself and brings 'main' online; no need to keep this command running.",
    "Check on it with: openclaw filament status --agent main",
  ]);
  assert.deepEqual(io.warn, [
    "Agent 'main' was bound to Filament account 'pending-abc'; removed that account.",
  ]);
  assert.equal(http.calls.filter((c) => c.url.endsWith("/token")).length, 0);
  assert.deepEqual(cli.patch(), {
    plugins: {
      entries: {
        "filament-openclaw": {
          config: {
            accounts: {
              "pending-abc": null,
              main: { pendingSignIn: PENDING, mcpUrl: MCP },
            },
          },
        },
      },
    },
    bindings: [{ agentId: "main", match: { channel: "filament", accountId: "main" } }],
  });
  // The device code travels on stdin, never in argv.
  for (const call of cli.calls) assert.ok(!call.args.join(" ").includes("dev_1"));
});

test("runLogin --wait: polls here and saves the token", async () => {
  const http = fakeHttp(server(), [
    [400, { error: "authorization_pending" }],
    [200, { access_token: "fmcp_new" }],
  ]);
  const cli = fakeConfigCli({ pluginConfig: {}, bindings: [] });
  const io = collect();
  const code = await runLogin(
    { wait: true, url: MCP },
    {
      ...io.deps,
      gatewayConfig: gateway(["main"]),
      workspace: nowhere,
      env: {},
      fetch: http.fetch,
      sleep: async () => {},
      writeConfig: cli.writeConfig,
    },
  );
  assert.equal(code, 0);
  assert.equal(io.out[0], `Connecting OpenClaw agent "main" (the gateway's only agent).`);
  assert.deepEqual(io.out.slice(-4), [
    "Waiting for approval ...",
    "Signed in. Saving the configuration ...",
    "Connected. Configuration saved.",
    "The gateway reloads the Filament plugin and brings 'main' online; follow along with: openclaw logs --follow",
  ]);
  assert.deepEqual(cli.patch().plugins.entries["filament-openclaw"].config.accounts, {
    main: { connectToken: "fmcp_new", mcpUrl: MCP },
  });
  for (const call of cli.calls) assert.ok(!call.args.join(" ").includes("fmcp_new"));
});

test("runLogin: without a device grant it signs in through the browser and saves the token", async () => {
  const http = fakeHttp(server(false), [[200, { access_token: "fmcp_browser" }]]);
  const cli = fakeConfigCli({ pluginConfig: {}, bindings: [] });
  const out: string[] = [];
  const done = runLogin(
    { url: MCP, open: false },
    {
      out: (line) => void out.push(line),
      warn: () => {},
      gatewayConfig: gateway(["main"]),
      workspace: nowhere,
      env: {},
      fetch: http.fetch,
      pasteInput: null,
      writeConfig: cli.writeConfig,
    },
  );
  let url: string | undefined;
  for (let i = 0; i < 200 && !url; i++) {
    url = out.find((line) => line.startsWith(`${ISSUER}/authorize`));
    if (!url) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const query = new URL(url!).searchParams;
  await globalThis.fetch(`${query.get("redirect_uri")}?code=c1&state=${query.get("state")}`);
  assert.equal(await done, 0);
  assert.ok(out.includes("Connected. Configuration saved."));
  assert.equal(
    cli.patch().plugins.entries["filament-openclaw"].config.accounts.main.connectToken,
    "fmcp_browser",
  );
});

test("runLogin: a failed sign-in or save exits 1 with the reason, writing nothing", async () => {
  const failing = async (
    opts: LoginCommandOptions,
    http: ReturnType<typeof fakeHttp>,
    write?: () => Promise<boolean>,
  ) => {
    const io = collect();
    let wrote = false;
    const code = await runLogin(
      { url: MCP, ...opts },
      {
        ...io.deps,
        gatewayConfig: gateway(["main"]),
        workspace: nowhere,
        env: {},
        fetch: http.fetch,
        sleep: async () => {},
        writeConfig: write ?? (async () => (wrote = true)),
      },
    );
    return { code, io, wrote };
  };
  const refused = await failing(
    { wait: true },
    fakeHttp(server(), [[400, { error: "access_denied" }]]),
  );
  assert.equal(refused.code, 1);
  assert.equal(refused.wrote, false);
  assert.deepEqual(refused.io.warn, ["error: Sign-in was declined (access_denied)."]);

  const noOauth = await failing({}, fakeHttp({}));
  assert.match(noOauth.io.warn[0]!, /does not offer OAuth sign-in/);

  const ambiguous = await runLogin(
    {},
    { ...collect().deps, gatewayConfig: gateway(["a", "b"]), workspace: nowhere },
  );
  assert.equal(ambiguous, 1);

  const both = await failing({ device: true, browser: true }, fakeHttp(server()));
  assert.match(both.io.warn[0]!, /mutually exclusive/);

  const unsaved = await failing({}, fakeHttp(server()), async () => {
    throw new Error("openclaw config patch failed (exit 1): invalid");
  });
  assert.equal(unsaved.code, 1);
  assert.match(
    unsaved.io.warn[0]!,
    /could not be handed to the gateway: .*invalid\. Run the login again\./,
  );
});

test("describeAccount / runStatus: one line per agent, then accounts bound to none", async () => {
  const cfg = gateway(["main", "news", "ops", "idle"], {
    plugins: {
      entries: {
        "filament-openclaw": {
          config: {
            accounts: {
              main: { connectToken: "fmcp_m" },
              news: { pendingSignIn: PENDING },
              ops: { connectToken: "fmcp_o" },
              gateway: { connectToken: "fmcp_g", control: true },
              "pending-abc": { connectToken: "fmcp_p", pending: true },
            },
          },
        },
      },
    },
    bindings: [
      { agentId: "main", match: { channel: "filament", accountId: "main" } },
      { agentId: "news", match: { channel: "filament", accountId: "news" } },
      { agentId: "ops", match: { channel: "filament", accountId: "ops" } },
    ],
  });
  const lines = async (now: number, opts: { agent?: string } = {}, ended?: SignInEnd) => {
    const out: string[] = [];
    const code = await runStatus(opts, {
      gatewayConfig: cfg,
      out: (line) => void out.push(line),
      warn: (line) => void out.push(line),
      now: () => now,
      loadIdentity: (id) =>
        id === "main" || id === "gateway"
          ? { mxid: `@${id}:filament.dm`, principal: "@p:x", onboardedAt: 1 }
          : undefined,
      loadSignInEnd: (id) => (id === "idle" ? ended : undefined),
      loadRevoked: () => undefined,
      probe: async (_url, token) =>
        token === "fmcp_m" ? { kind: "ok", mxid: "@main:filament.dm" } : { kind: "ok" },
    });
    return { code, out };
  };
  assert.deepEqual(await lines(T0 + 1_000), {
    code: 0,
    out: [
      'connected as @main:filament.dm (OpenClaw agent "main")',
      'waiting for sign-in approval, expires in 599s (OpenClaw agent "news")',
      'signed in; waiting for the gateway to connect (OpenClaw agent "ops")',
      'not signed in (OpenClaw agent "idle")',
      'retired; remove it from the config (Filament account "gateway", a gateway control account)',
      'retired; remove it from the config (Filament account "pending-abc", an agent-choice account)',
    ],
  });
  assert.deepEqual((await lines(T0 + 600_000, { agent: "news" })).out, [
    'sign-in expired (OpenClaw agent "news")',
  ]);
  const expired = { reason: "expired" as const, at: T0 };
  assert.deepEqual((await lines(T0, { agent: "idle" }, expired)).out, [
    'sign-in expired (OpenClaw agent "idle")',
  ]);
  const declined = { reason: "denied" as const, at: T0 };
  assert.deepEqual((await lines(T0, { agent: "idle" }, declined)).out, [
    'sign-in declined (OpenClaw agent "idle")',
  ]);
  const unknown = await lines(T0, { agent: "nope" });
  assert.equal(unknown.code, 1);
  assert.match(unknown.out[0]!, /no OpenClaw agent "nope"/);
  // A store the CLI cannot open costs the detail, not the command.
  const out: string[] = [];
  await runStatus(
    { agent: "main" },
    {
      gatewayConfig: cfg,
      out: (line) => void out.push(line),
      loadIdentity: () => {
        throw new Error("no store here");
      },
      loadRevoked: () => {
        throw new Error("no store here");
      },
      probe: async () => ({ kind: "unknown" }),
    },
  );
  assert.deepEqual(out, ['signed in; waiting for the gateway to connect (OpenClaw agent "main")']);
});

test("runStatus: a token Filament rejects, or the gateway saw rejected, is revoked, not connected", async () => {
  const cfg = gateway(["main"], {
    plugins: {
      entries: {
        "filament-openclaw": {
          config: { mcpUrl: DEV, accounts: { main: { connectToken: "fmcp_m" } } },
        },
      },
    },
    bindings: [{ agentId: "main", match: { channel: "filament", accountId: "main" } }],
  });
  const identity = { mxid: "@main:filament.dm", principal: "@p:x", onboardedAt: 1 };
  const status = async (probe: ProbeResult, revokedToken?: string) => {
    const out: string[] = [];
    const probed: Array<[string, string]> = [];
    await runStatus(
      { agent: "main" },
      {
        gatewayConfig: cfg,
        out: (line) => void out.push(line),
        loadIdentity: () => identity,
        loadSignInEnd: () => undefined,
        loadRevoked: () =>
          revokedToken ? { fingerprint: tokenFingerprint(revokedToken), at: 1 } : undefined,
        probe: async (url, token) => {
          probed.push([url, token]);
          return probe;
        },
      },
    );
    return { line: out[0], probed };
  };
  const live = await status({ kind: "ok", mxid: "@main:filament.dm" });
  assert.equal(live.line, 'connected as @main:filament.dm (OpenClaw agent "main")');
  // The probe uses the account's own server and token.
  assert.deepEqual(live.probed, [[DEV, "fmcp_m"]]);
  assert.equal(
    (await status({ kind: "revoked" })).line,
    'sign-in revoked; run openclaw filament login again (OpenClaw agent "main")',
  );
  // Offline: the gateway's record of a rejection stands; without one, the stored identity.
  assert.equal(
    (await status({ kind: "unknown" }, "fmcp_m")).line,
    'sign-in revoked; run openclaw filament login again (OpenClaw agent "main")',
  );
  assert.equal(
    (await status({ kind: "unknown" })).line,
    'connected as @main:filament.dm (not verified) (OpenClaw agent "main")',
  );
  // A rejection recorded for an older token says nothing about this one.
  assert.equal(
    (await status({ kind: "unknown" }, "fmcp_old")).line,
    'connected as @main:filament.dm (not verified) (OpenClaw agent "main")',
  );
  // A live token for a newer agent than the gateway last connected as.
  assert.equal(
    (await status({ kind: "ok", mxid: "@new:filament.dm" })).line,
    'signed in; waiting for the gateway to connect (OpenClaw agent "main")',
  );
});

test("probeBearer: get_self with the token; 401 is revoked, a dead server unknown", async () => {
  const realFetch = globalThis.fetch;
  try {
    const answer = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const seen: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization");
      seen.push(auth ?? "");
      if (auth !== "Bearer fmcp_good") return answer(401, {});
      const call = JSON.parse(String(init.body)) as { id?: number; method?: string };
      if (call.method === "initialize")
        return answer(200, { jsonrpc: "2.0", id: call.id, result: {} });
      if (!call.id) return new Response(null, { status: 202 });
      return answer(200, {
        jsonrpc: "2.0",
        id: call.id,
        result: {
          structuredContent: { user_id: "@a:x", owner: { user_id: "@p:x" } },
          content: [
            { type: "text", text: JSON.stringify({ user_id: "@a:x", owner: { user_id: "@p:x" } }) },
          ],
        },
      });
    }) as typeof fetch;
    assert.deepEqual(await probeBearer("https://f/mcp/agents", "fmcp_good"), {
      kind: "ok",
      mxid: "@a:x",
    });
    assert.deepEqual(await probeBearer("https://f/mcp/agents", "fmcp_bad"), { kind: "revoked" });
    assert.ok(seen.every((auth) => auth.startsWith("Bearer fmcp_")));
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    assert.deepEqual(await probeBearer("https://f/mcp/agents", "fmcp_good"), { kind: "unknown" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("registerFilamentCli: `openclaw filament login` and `status` with a lazy root descriptor", async () => {
  type Node = {
    name: string;
    options: string[];
    children: Node[];
    handler?: (o: LoginCommandOptions) => unknown;
  };
  const make = (name: string): Node & CliCommand => {
    const node: Node = { name, options: [], children: [] };
    const command: CliCommand = {
      command: (child) => {
        const created = make(child);
        node.children.push(created);
        return created;
      },
      description: () => command,
      option: (flags) => {
        node.options.push(flags);
        return command;
      },
      action: (handler) => {
        node.handler = handler;
        return command;
      },
    };
    return Object.assign(node, command);
  };
  const program = make("openclaw");
  let descriptors: unknown;
  registerFilamentCli({
    registerCli: (registrar, opts) => {
      descriptors = opts?.descriptors;
      void registrar({ program, config: {} });
    },
  });
  assert.deepEqual(descriptors, [
    { name: "filament", description: "Connect OpenClaw agents to Filament", hasSubcommands: true },
  ]);
  const [login, status] = program.children[0]!.children;
  assert.equal(program.children[0]!.name, "filament");
  assert.equal(login!.name, "login");
  assert.deepEqual(login!.options, [
    "--agent <id>",
    "--url <url>",
    "--device",
    "--wait",
    "--browser",
    "--no-open",
  ]);
  assert.equal(status!.name, "status");
  assert.deepEqual(status!.options, ["--agent <id>"]);
  assert.equal(typeof login!.handler, "function");
  assert.equal(typeof status!.handler, "function");
});
