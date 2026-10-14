import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  asRecord,
  DEFAULT_ACCOUNT_ID,
  hasPendingSignIn,
  hasTokenInput,
  listConfiguredAccountIds,
  PLUGIN_ID,
  pluginConfigFrom,
  retiredAccountKind
} from "./accounts.js";
import { writeGatewayConfig } from "./config-write.js";
import {
  AGENT_ID_PATTERN,
  applyAgentConnect,
  listGatewayAgents,
  RESERVED_ACCOUNT_IDS
} from "./gateway.js";
import {
  authorizationCodeLogin,
  consoleOut,
  discover,
  LoginError,
  pollDeviceToken,
  startDeviceLogin
} from "./oauth-login.js";
import { FilamentMcpClient } from "./mcp-client.js";
import { classifyGetSelf } from "./onboarding-core.js";
import { DEFAULT_MCP_URL, normalizeMcpUrl, resolveAccountSettings } from "./settings.js";
import { parsePendingSignIn, toPendingSignIn } from "./sign-in.js";
import { loadIdentity } from "./state/identities.js";
import {
  loadRevoked,
  loadSignInEnd,
  tokenFingerprint
} from "./state/sign-in.js";
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
  return typeof raw === "string" && raw.trim() ? normalizeMcpUrl(raw) : void 0;
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
function applyLogin(draft, agentId, credential, mcpUrl) {
  const token = "connectToken" in credential ? credential.connectToken : "";
  const result = applyAgentConnect(draft, agentId, token);
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  const account = asRecord(asRecord(config.accounts)[agentId]);
  if ("pendingSignIn" in credential) {
    delete account.connectToken;
    account.pendingSignIn = credential.pendingSignIn;
  } else {
    delete account.pendingSignIn;
  }
  if (mcpUrl === (trimUrl(config.mcpUrl) ?? DEFAULT_MCP_URL)) delete account.mcpUrl;
  else account.mcpUrl = mcpUrl;
  return result;
}
const consoleWarn = (line) => new Promise((resolve2) => {
  process.stderr.write(`${line}
`, () => resolve2());
});
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
async function runLogin(opts, deps) {
  const out = deps.out ?? consoleOut;
  const warn = deps.warn ?? consoleWarn;
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  try {
    if (opts.device && opts.browser) {
      throw new LoginError("--device and --browser are mutually exclusive.");
    }
    if (opts.wait && opts.browser) {
      throw new LoginError("--wait is for the device sign-in; the browser sign-in always waits.");
    }
    const { agentId, reason } = resolveLoginAgent(deps.gatewayConfig, opts.agent, deps.workspace);
    const mcpUrl = resolveLoginUrl(
      pluginConfigFrom(deps.gatewayConfig),
      agentId,
      opts.url,
      deps.env ?? process.env
    );
    await out(`Connecting OpenClaw agent "${agentId}" (${reason}).`);
    await out(`Signing in to Filament at ${mcpUrl} ...`);
    const meta = await discover(mcpUrl, fetchImpl);
    const device = opts.device || !opts.browser && meta.deviceAuthorizationEndpoint !== void 0;
    let credential;
    if (!device) {
      const token = await authorizationCodeLogin(meta, {
        fetch: fetchImpl,
        out,
        openBrowser: opts.open ?? true,
        pasteInput: deps.pasteInput
      });
      credential = { connectToken: token };
    } else {
      const auth = await startDeviceLogin(meta, { fetch: fetchImpl, out, now });
      if (opts.wait) {
        await out("Waiting for approval ...");
        const token = await pollDeviceToken(auth, { fetch: fetchImpl, sleep: deps.sleep, now });
        credential = { connectToken: token };
      } else {
        credential = { pendingSignIn: toPendingSignIn(auth) };
      }
    }
    const handoff = "pendingSignIn" in credential;
    if (!handoff) await out("Signed in. Saving the configuration ...");
    let displaced = [];
    try {
      await (deps.writeConfig ?? writeGatewayConfig)((draft) => {
        displaced = applyLogin(draft, agentId, credential, mcpUrl).displaced;
      });
    } catch (error) {
      throw new LoginError(
        `${handoff ? "The sign-in could not be handed to the gateway" : "Signed in, but the configuration could not be saved"}: ${errorText(error)}. Run the login again.`
      );
    }
    for (const other of displaced) {
      await warn(
        `Agent '${agentId}' was bound to Filament account '${other}'; removed that account.`
      );
    }
    if ("pendingSignIn" in credential) {
      const minutes = Math.max(
        1,
        Math.round((Date.parse(credential.pendingSignIn.expiresAt) - now()) / 6e4)
      );
      await out(`The link expires in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
      await out(
        `Approve the link above. This gateway finishes the sign-in by itself and brings '${agentId}' online; no need to keep this command running.`
      );
      await out(`Check on it with: openclaw filament status --agent ${agentId}`);
      return 0;
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
const PROBE_TIMEOUT_MS = 5e3;
const probeBearer = async (mcpUrl, token) => {
  try {
    const result = await new FilamentMcpClient(mcpUrl, token).callTool(
      "get_self",
      {},
      { timeoutMs: PROBE_TIMEOUT_MS }
    );
    const decision = classifyGetSelf(result);
    if (decision.status === "auth_failed") return { kind: "revoked" };
    if (result.ok) return { kind: "ok", mxid: decision.identity?.mxid || void 0 };
    return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
};
function plainToken(pluginConfig, accountId) {
  const cfg = asRecord(pluginConfig);
  const entry = asRecord(asRecord(cfg.accounts)[accountId]);
  const raw = entry.connectToken ?? (accountId === DEFAULT_ACCOUNT_ID ? cfg.connectToken : void 0);
  return typeof raw === "string" && raw.trim() && !/^\$\{.*\}$/.test(raw.trim()) ? raw.trim() : void 0;
}
function tryLoad(load, accountId) {
  try {
    return load(accountId);
  } catch {
    return void 0;
  }
}
function describeAccount(pluginConfig, accountId, deps) {
  if (retiredAccountKind(pluginConfig, accountId)) return "retired; remove it from the config";
  const cfg = asRecord(pluginConfig);
  const entry = asRecord(asRecord(cfg.accounts)[accountId]);
  if (hasPendingSignIn(entry)) {
    const pending = parsePendingSignIn(entry.pendingSignIn);
    const left = pending ? Math.floor((pending.expiresAt - deps.now()) / 1e3) : 0;
    return left > 0 ? `waiting for sign-in approval, expires in ${left}s` : "sign-in expired";
  }
  const token = hasTokenInput(entry.connectToken) || accountId === DEFAULT_ACCOUNT_ID && hasTokenInput(cfg.connectToken);
  if (token) {
    const { probe } = deps;
    const plain = plainToken(pluginConfig, accountId);
    const marker = tryLoad(deps.loadRevoked, accountId);
    const marked = marker !== void 0 && (!plain || marker.fingerprint === tokenFingerprint(plain));
    if (probe?.kind === "revoked" || probe?.kind !== "ok" && marked) {
      return "sign-in revoked; run openclaw filament login again";
    }
    const identity = tryLoad(deps.loadIdentity, accountId);
    if (!identity || probe?.kind === "ok" && probe.mxid && probe.mxid !== identity.mxid) {
      return "signed in; waiting for the gateway to connect";
    }
    return probe?.kind === "ok" ? `connected as ${identity.mxid}` : `connected as ${identity.mxid} (not verified)`;
  }
  const end = tryLoad(deps.loadSignInEnd, accountId);
  if (end?.reason === "expired") return "sign-in expired";
  if (end?.reason === "denied") return "sign-in declined";
  if (end?.reason === "failed") return "sign-in failed";
  return "not signed in";
}
async function runStatus(opts, deps) {
  const out = deps.out ?? consoleOut;
  const baseDeps = {
    now: deps.now ?? Date.now,
    loadIdentity: deps.loadIdentity ?? loadIdentity,
    loadSignInEnd: deps.loadSignInEnd ?? loadSignInEnd,
    loadRevoked: deps.loadRevoked ?? loadRevoked
  };
  const pluginConfig = pluginConfigFrom(deps.gatewayConfig);
  const probe = deps.probe ?? probeBearer;
  const env = deps.env ?? process.env;
  const probes = /* @__PURE__ */ new Map();
  const probeOf = (accountId) => {
    const token = plainToken(pluginConfig, accountId);
    if (!token || retiredAccountKind(pluginConfig, accountId)) return Promise.resolve(void 0);
    let pending = probes.get(accountId);
    if (!pending) {
      pending = probe(resolveAccountSettings(pluginConfig, accountId, env).mcpUrl, token);
      probes.set(accountId, pending);
    }
    return pending;
  };
  const describe = async (accountId) => describeAccount(pluginConfig, accountId, { ...baseDeps, probe: await probeOf(accountId) });
  const agents = listGatewayAgents(deps.gatewayConfig).filter(
    (agent) => !RESERVED_ACCOUNT_IDS.has(agent.id)
  );
  let shown = agents;
  if (opts.agent !== void 0) {
    const wanted = opts.agent.trim().toLowerCase();
    shown = agents.filter((agent) => agent.id === wanted);
    if (shown.length === 0) {
      await (deps.warn ?? consoleWarn)(
        `error: This gateway has no OpenClaw agent "${wanted}" (agents: ${agents.map((a) => a.id).join(", ") || "none"}).`
      );
      return 1;
    }
  }
  const agentLines = shown.map(
    async (agent) => `${await describe(agent.boundAccount ?? agent.id)} (OpenClaw agent "${agent.id}")`
  );
  for (const line of agentLines) await out(await line);
  if (opts.agent !== void 0) return 0;
  const claimed = new Set(agents.flatMap((agent) => [agent.boundAccount, agent.id]));
  const unbound = listConfiguredAccountIds(pluginConfig, {}).filter(
    (id) => !claimed.has(id) && (id !== DEFAULT_ACCOUNT_ID || hasTokenInput(asRecord(pluginConfig).connectToken))
  );
  for (const accountId of unbound) {
    const retired = retiredAccountKind(pluginConfig, accountId);
    const role = retired === "control" ? ", a gateway control account" : retired === "pending" ? ", an agent-choice account" : "";
    await out(`${await describe(accountId)} (Filament account "${accountId}"${role})`);
  }
  return 0;
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
      ).option("--device", "sign in from any device with a link and a code (the default)").option("--wait", "wait here for the approval instead of leaving it to the gateway").option("--browser", "sign in with a browser and a local callback").option("--no-open", "print the sign-in link rather than opening a browser").action(async (options) => {
        process.exitCode = await runLogin(options, { gatewayConfig: config });
      });
      root.command("status").description("Show whether each OpenClaw agent is signed in to Filament").option("--agent <id>", "only this OpenClaw agent").action(async (options) => {
        process.exitCode = await runStatus(options, { gatewayConfig: config });
      });
    },
    { descriptors: [{ name: CLI_ROOT, description: ROOT_DESCRIPTION, hasSubcommands: true }] }
  );
}
export {
  CLI_ROOT,
  applyLogin,
  describeAccount,
  probeBearer,
  registerFilamentCli,
  resolveLoginAgent,
  resolveLoginUrl,
  runLogin,
  runStatus
};
