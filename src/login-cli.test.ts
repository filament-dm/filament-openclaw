import assert from "node:assert/strict";
import { test } from "node:test";

import { writeGatewayConfig, type CliResult } from "./config-write.js";
import {
  applyLogin,
  registerFilamentCli,
  resolveLoginAgent,
  resolveLoginUrl,
  runLogin,
  type CliCommand,
  type LoginCommandOptions,
} from "./login-cli.js";
import { LoginError } from "./oauth-login.js";

const PROD = "https://api.filament.dm/mcp/agents";
const DEV = "http://filament-dev.local:8448/mcp/agents";

function gateway(ids: string[], extra: Record<string, unknown> = {}) {
  return { agents: { entries: Object.fromEntries(ids.map((id) => [id, {}])) }, ...extra };
}

test("resolveLoginAgent: the named agent, else the only one", () => {
  assert.equal(resolveLoginAgent(gateway(["main", "news"]), "News"), "news");
  assert.equal(resolveLoginAgent(gateway(["writer"])), "writer");
  // No agents configured: OpenClaw's implicit `main`.
  assert.equal(resolveLoginAgent({}), "main");
});

test("resolveLoginAgent: an unknown, reserved, malformed or ambiguous agent is refused", () => {
  const cfg = gateway(["main", "news"]);
  assert.throws(() => resolveLoginAgent(cfg), /several OpenClaw agents \(main, news\).*--agent/);
  assert.throws(
    () => resolveLoginAgent(cfg, "nope"),
    /no OpenClaw agent "nope" \(agents: main, news\)/,
  );
  assert.throws(() => resolveLoginAgent(cfg, "gateway"), LoginError);
  assert.throws(() => resolveLoginAgent(cfg, "bad id!"), /not a usable OpenClaw agent id/);
});

test("resolveLoginUrl: flag, env, the account's, the plugin's, production", () => {
  const cfg = {
    mcpUrl: "https://top/mcp/agents/",
    accounts: { main: { mcpUrl: "https://acct/x" } },
  };
  assert.equal(resolveLoginUrl(cfg, "main", `${DEV}/`, { FILAMENT_MCP_URL: "https://env" }), DEV);
  assert.equal(
    resolveLoginUrl(cfg, "main", undefined, { FILAMENT_MCP_URL: "https://env" }),
    "https://env",
  );
  assert.equal(resolveLoginUrl(cfg, "main", undefined, {}), "https://acct/x");
  assert.equal(resolveLoginUrl(cfg, "other", undefined, {}), "https://top/mcp/agents");
  assert.equal(resolveLoginUrl(undefined, "main", undefined, {}), PROD);
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
  assert.deepEqual(applyLogin(draft, "main", "fmcp_new", PROD), { displaced: ["pending-abc"] });
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

test("applyLogin: a URL other than the plugin's is kept on the account, the plugin's is not", () => {
  const draft = draftOf({ accounts: { main: { connectToken: "fmcp_old", mcpUrl: DEV } } });
  applyLogin(draft, "main", "fmcp_a", DEV);
  assert.deepEqual(configOf(draft).accounts.main, { connectToken: "fmcp_a", mcpUrl: DEV });
  applyLogin(draft, "main", "fmcp_b", PROD);
  assert.deepEqual(configOf(draft).accounts.main, { connectToken: "fmcp_b" });

  const dev = draftOf({ mcpUrl: DEV });
  applyLogin(dev, "main", "fmcp_c", DEV);
  assert.deepEqual(configOf(dev).accounts.main, { connectToken: "fmcp_c" });
  applyLogin(dev, "main", "fmcp_d", PROD);
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

test("runLogin: signs the agent in, writes its account through the CLI, says so", async () => {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const file = {
    pluginConfig: { accounts: { "pending-abc": { connectToken: "fmcp_old", pending: true } } },
    bindings: [{ agentId: "main", match: { channel: "filament", accountId: "pending-abc" } }],
  };
  const run = async (args: string[], stdin?: string): Promise<CliResult> => {
    calls.push({ args, stdin });
    const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: "" });
    if (args[1] === "get" && args[2] === "bindings") return ok(JSON.stringify(file.bindings));
    if (args[1] === "get") return ok(JSON.stringify(file.pluginConfig));
    return ok("");
  };
  const logins: Array<{ url: string; flow?: string; openBrowser?: boolean }> = [];
  const io = collect();
  const code = await runLogin(
    { agent: "main", device: true, open: false },
    {
      ...io.deps,
      gatewayConfig: gateway(["main", "news"]),
      env: { FILAMENT_MCP_URL: DEV },
      login: async (url, opts) => {
        logins.push({ url, flow: opts?.flow, openBrowser: opts?.openBrowser });
        await opts?.out?.("Code: BCDF-GHJK");
        return "fmcp_new";
      },
      writeConfig: (mutate) => writeGatewayConfig(mutate, run),
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(logins, [{ url: DEV, flow: "device", openBrowser: false }]);
  assert.equal(io.out[0], `Signing in OpenClaw agent 'main' to Filament at ${DEV} ...`);
  assert.ok(io.out.includes("Code: BCDF-GHJK"));
  assert.ok(io.out.includes("Connected. Configuration saved."));
  assert.deepEqual(io.warn, [
    "Agent 'main' was bound to Filament account 'pending-abc'; removed that account.",
  ]);
  const patch = JSON.parse(calls.find((c) => c.args[1] === "patch")!.stdin!);
  assert.deepEqual(patch, {
    plugins: {
      entries: {
        "filament-openclaw": {
          config: {
            accounts: { "pending-abc": null, main: { connectToken: "fmcp_new", mcpUrl: DEV } },
          },
        },
      },
    },
    bindings: [{ agentId: "main", match: { channel: "filament", accountId: "main" } }],
  });
  // The token travels on stdin, never in argv.
  for (const call of calls) assert.ok(!call.args.join(" ").includes("fmcp_new"));
});

test("runLogin: a failed sign-in or save exits 1 with the reason, writing nothing", async () => {
  const failing = async (
    opts: LoginCommandOptions,
    login: () => Promise<string>,
    write?: () => Promise<boolean>,
  ) => {
    const io = collect();
    let wrote = false;
    const code = await runLogin(opts, {
      ...io.deps,
      gatewayConfig: gateway(["main"]),
      env: {},
      login,
      writeConfig: write ?? (async () => (wrote = true)),
    });
    return { code, io, wrote };
  };
  const refused = await failing({}, async () => {
    throw new LoginError("Sign-in was declined (access_denied).");
  });
  assert.equal(refused.code, 1);
  assert.equal(refused.wrote, false);
  assert.deepEqual(refused.io.warn, ["error: Sign-in was declined (access_denied)."]);
  assert.ok(!refused.io.out.includes("Connected. Configuration saved."));

  const ambiguous = await runLogin(
    {},
    {
      ...collect().deps,
      gatewayConfig: gateway(["a", "b"]),
      login: async () => assert.fail("no login"),
    },
  );
  assert.equal(ambiguous, 1);

  const both = await failing({ device: true, browser: true }, async () => assert.fail("no login"));
  assert.match(both.io.warn[0]!, /mutually exclusive/);

  const unsaved = await failing(
    {},
    async () => "fmcp_x",
    async () => {
      throw new Error("openclaw config patch failed (exit 1): invalid");
    },
  );
  assert.equal(unsaved.code, 1);
  assert.match(
    unsaved.io.warn[0]!,
    /Signed in, but the configuration could not be saved: .*invalid/,
  );
});

test("registerFilamentCli: `openclaw filament login` with a lazy root descriptor", async () => {
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
  const login = program.children[0]!.children[0]!;
  assert.equal(program.children[0]!.name, "filament");
  assert.equal(login.name, "login");
  assert.deepEqual(login.options, [
    "--agent <id>",
    "--url <url>",
    "--device",
    "--browser",
    "--no-open",
  ]);
  assert.equal(typeof login.handler, "function");
});
