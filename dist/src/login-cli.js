import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { asRecord, PLUGIN_ID, pluginConfigFrom } from "./accounts.js";
import { writeGatewayConfig } from "./config-write.js";
import {
  AGENT_ID_PATTERN,
  applyAgentConnect,
  listGatewayAgents,
  RESERVED_ACCOUNT_IDS
} from "./gateway.js";
import { consoleOut, login, LoginError } from "./oauth-login.js";
import { DEFAULT_MCP_URL } from "./settings.js";
const CLI_ROOT = "filament";
function realpathOrSame(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
function agentWorkspaces(gatewayConfig, agentIds, ctx) {
  const agents = asRecord(asRecord(gatewayConfig).agents);
  const entries = asRecord(agents.entries);
  const fallback = asRecord(agents.defaults).workspace;
  const workspaces = /* @__PURE__ */ new Map();
  for (const id of agentIds) {
    const raw = asRecord(entries[id]).workspace ?? fallback;
    if (typeof raw !== "string" || !raw.trim()) continue;
    const expanded = raw.trim().replace(/^~(?=$|[\\/])/, () => ctx.home);
    if (!isAbsolute(expanded)) continue;
    workspaces.set(id, ctx.realpath(resolve(expanded)));
  }
  return workspaces;
}
function resolveLoginAgent(gatewayConfig, requested, workspace = {}) {
  const agents = listGatewayAgents(gatewayConfig).map((agent) => agent.id).filter((id) => !RESERVED_ACCOUNT_IDS.has(id));
  const known = agents.length > 0 ? agents.join(", ") : "none";
  if (requested !== void 0) {
    const agentId = requested.trim().toLowerCase();
    if (!AGENT_ID_PATTERN.test(agentId) || RESERVED_ACCOUNT_IDS.has(agentId)) {
      throw new LoginError(`"${requested}" is not a usable OpenClaw agent id.`);
    }
    if (!agents.includes(agentId)) {
      throw new LoginError(`This gateway has no OpenClaw agent "${agentId}" (agents: ${known}).`);
    }
    return { agentId, reason: "named with --agent" };
  }
  const ctx = {
    cwd: workspace.cwd ?? process.cwd(),
    home: workspace.home ?? homedir(),
    realpath: workspace.realpath ?? realpathOrSame
  };
  const cwd = ctx.realpath(resolve(ctx.cwd));
  let best = { ids: [], dir: "" };
  for (const [id, dir] of agentWorkspaces(gatewayConfig, agents, ctx)) {
    const inside = relative(dir, cwd);
    if (inside.split(sep)[0] === ".." || isAbsolute(inside)) continue;
    if (dir.length > best.dir.length) best = { ids: [id], dir };
    else if (dir === best.dir) best.ids.push(id);
  }
  if (best.ids.length === 1) {
    return {
      agentId: best.ids[0],
      reason: best.dir === cwd ? "its workspace is the current directory" : "the current directory is in its workspace"
    };
  }
  if (agents.length === 1) return { agentId: agents[0], reason: "the gateway's only agent" };
  throw new LoginError(
    agents.length === 0 ? "This gateway has no OpenClaw agent to connect." : `Could not tell which OpenClaw agent to connect (agents: ${known}); pass --agent <id>.`
  );
}
function trimUrl(raw) {
  return typeof raw === "string" && raw.trim() ? raw.trim().replace(/\/+$/, "") : void 0;
}
function resolveLoginUrl(pluginConfig, agentId, flagUrl, env = process.env) {
  const cfg = asRecord(pluginConfig);
  const url = trimUrl(flagUrl) ?? trimUrl(env.FILAMENT_MCP_URL) ?? trimUrl(asRecord(asRecord(cfg.accounts)[agentId]).mcpUrl) ?? trimUrl(cfg.mcpUrl) ?? DEFAULT_MCP_URL;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new LoginError(`"${url}" is not a Filament MCP URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new LoginError(`"${url}" is not a Filament MCP URL.`);
  }
  return url;
}
function applyLogin(draft, agentId, token, mcpUrl) {
  const result = applyAgentConnect(draft, agentId, token);
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  const account = asRecord(asRecord(config.accounts)[agentId]);
  if (mcpUrl === (trimUrl(config.mcpUrl) ?? DEFAULT_MCP_URL)) delete account.mcpUrl;
  else account.mcpUrl = mcpUrl;
  return result;
}
const consoleWarn = (line) => new Promise((resolve2) => {
  process.stderr.write(`${line}
`, () => resolve2());
});
async function runLogin(opts, deps) {
  const out = deps.out ?? consoleOut;
  const warn = deps.warn ?? consoleWarn;
  try {
    if (opts.device && opts.browser) {
      throw new LoginError("--device and --browser are mutually exclusive.");
    }
    const flow = opts.device ? "device" : opts.browser ? "browser" : "auto";
    const { agentId, reason } = resolveLoginAgent(deps.gatewayConfig, opts.agent, deps.workspace);
    const mcpUrl = resolveLoginUrl(
      pluginConfigFrom(deps.gatewayConfig),
      agentId,
      opts.url,
      deps.env ?? process.env
    );
    await out(`Connecting OpenClaw agent "${agentId}" (${reason}).`);
    await out(`Signing in to Filament at ${mcpUrl} ...`);
    const token = await (deps.login ?? login)(mcpUrl, {
      flow,
      out,
      openBrowser: opts.open ?? true
    });
    await out("Signed in. Saving the configuration ...");
    let displaced = [];
    try {
      await (deps.writeConfig ?? writeGatewayConfig)((draft) => {
        displaced = applyLogin(draft, agentId, token, mcpUrl).displaced;
      });
    } catch (error) {
      throw new LoginError(
        `Signed in, but the configuration could not be saved: ${error instanceof Error ? error.message : String(error)}. Run the login again.`
      );
    }
    for (const other of displaced) {
      await warn(
        `Agent '${agentId}' was bound to Filament account '${other}'; removed that account.`
      );
    }
    await out("Connected. Configuration saved.");
    await out(
      `The gateway reloads the Filament plugin and brings '${agentId}' online; follow along with: openclaw logs --follow`
    );
    return 0;
  } catch (error) {
    if (!(error instanceof LoginError)) throw error;
    await warn(`error: ${error.message}`);
    return 1;
  }
}
const ROOT_DESCRIPTION = "Connect OpenClaw agents to Filament";
function registerFilamentCli(api) {
  api.registerCli(
    ({ program, config }) => {
      const root = program.command(CLI_ROOT).description(ROOT_DESCRIPTION);
      root.command("login").description("Sign an OpenClaw agent in to Filament, with no token to paste").option(
        "--agent <id>",
        "OpenClaw agent to connect (default: the one whose workspace holds the current directory, else the gateway's only agent)"
      ).option(
        "--url <url>",
        `Filament MCP endpoint (default: FILAMENT_MCP_URL, else ${DEFAULT_MCP_URL})`
      ).option("--device", "sign in from any device with a link and a code").option("--browser", "sign in with a browser and a local callback").option("--no-open", "print the sign-in link rather than opening a browser").action(async (options) => {
        process.exitCode = await runLogin(options, { gatewayConfig: config });
      });
    },
    { descriptors: [{ name: CLI_ROOT, description: ROOT_DESCRIPTION, hasSubcommands: true }] }
  );
}
export {
  CLI_ROOT,
  applyLogin,
  registerFilamentCli,
  resolveLoginAgent,
  resolveLoginUrl,
  runLogin
};
