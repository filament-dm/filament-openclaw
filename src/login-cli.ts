/**
 * `openclaw filament login`: signs an OpenClaw agent in to Filament with OAuth (oauth-login.ts).
 * By default it saves the device code as the agent's pending sign-in and exits, and the gateway
 * finishes it (sign-in.ts); `--wait` and the browser flow save the token here instead. Either way
 * the account is the one install.sh writes for a connect token, and the write goes through the CLI
 * (config-write.ts), an external change the running gateway reloads. `openclaw filament status`
 * reports each agent's sign-in.
 */
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
  retiredAccountKind,
} from "./accounts.js";
import { writeGatewayConfig } from "./config-write.js";
import {
  AGENT_ID_PATTERN,
  applyAgentConnect,
  listGatewayAgents,
  RESERVED_ACCOUNT_IDS,
} from "./gateway.js";
import {
  authorizationCodeLogin,
  consoleOut,
  discover,
  LoginError,
  pollDeviceToken,
  startDeviceLogin,
  type DeviceLoginOptions,
  type Out,
} from "./oauth-login.js";
import { DEFAULT_MCP_URL, normalizeMcpUrl } from "./settings.js";
import { parsePendingSignIn, toPendingSignIn, type PendingSignIn } from "./sign-in.js";
import { loadIdentity, type AgentIdentity } from "./state/identities.js";
import { loadSignInEnd, type SignInEnd } from "./state/sign-in.js";

export const CLI_ROOT = "filament";

export interface ChosenAgent {
  agentId: string;
  /** Why this agent, for the line that names it. */
  reason: string;
}

export interface WorkspaceContext {
  cwd?: string;
  home?: string;
  /** Resolves symlinks (macOS /tmp is /private/tmp); a path that does not exist stays as it is. */
  realpath?: (path: string) => string;
}

function realpathOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Each agent's workspace: its own, else `agents.defaults.workspace`. */
function agentWorkspaces(
  gatewayConfig: unknown,
  agentIds: readonly string[],
  ctx: Required<WorkspaceContext>,
): Map<string, string> {
  const agents = asRecord(asRecord(gatewayConfig).agents);
  const entries = asRecord(agents.entries);
  const fallback = asRecord(agents.defaults).workspace;
  const workspaces = new Map<string, string>();
  for (const id of agentIds) {
    const raw = asRecord(entries[id]).workspace ?? fallback;
    if (typeof raw !== "string" || !raw.trim()) continue;
    const expanded = raw.trim().replace(/^~(?=$|[\\/])/, () => ctx.home);
    if (!isAbsolute(expanded)) continue;
    workspaces.set(id, ctx.realpath(resolve(expanded)));
  }
  return workspaces;
}

/**
 * The agent to sign in: the one named; else the one whose workspace holds the current directory,
 * since an agent's exec tool runs there and nothing else tells a command which agent ran it; else
 * the gateway's only agent.
 */
export function resolveLoginAgent(
  gatewayConfig: unknown,
  requested?: string,
  workspace: WorkspaceContext = {},
): ChosenAgent {
  const agents = listGatewayAgents(gatewayConfig)
    .map((agent) => agent.id)
    .filter((id) => !RESERVED_ACCOUNT_IDS.has(id));
  const known = agents.length > 0 ? agents.join(", ") : "none";
  if (requested !== undefined) {
    const agentId = requested.trim().toLowerCase();
    if (!AGENT_ID_PATTERN.test(agentId) || RESERVED_ACCOUNT_IDS.has(agentId)) {
      throw new LoginError(`"${requested}" is not a usable OpenClaw agent id.`);
    }
    if (!agents.includes(agentId)) {
      throw new LoginError(`This gateway has no OpenClaw agent "${agentId}" (agents: ${known}).`);
    }
    return { agentId, reason: "named with --agent" };
  }
  const ctx: Required<WorkspaceContext> = {
    cwd: workspace.cwd ?? process.cwd(),
    home: workspace.home ?? homedir(),
    realpath: workspace.realpath ?? realpathOrSame,
  };
  const cwd = ctx.realpath(resolve(ctx.cwd));
  // The deepest workspace holding the directory wins; two agents sharing it is no answer.
  let best: { ids: string[]; dir: string } = { ids: [], dir: "" };
  for (const [id, dir] of agentWorkspaces(gatewayConfig, agents, ctx)) {
    const inside = relative(dir, cwd);
    if (inside.split(sep)[0] === ".." || isAbsolute(inside)) continue;
    if (dir.length > best.dir.length) best = { ids: [id], dir };
    else if (dir === best.dir) best.ids.push(id);
  }
  if (best.ids.length === 1) {
    return {
      agentId: best.ids[0]!,
      reason:
        best.dir === cwd
          ? "its workspace is the current directory"
          : "the current directory is in its workspace",
    };
  }
  if (agents.length === 1) return { agentId: agents[0]!, reason: "the gateway's only agent" };
  throw new LoginError(
    agents.length === 0
      ? "This gateway has no OpenClaw agent to connect."
      : `Could not tell which OpenClaw agent to connect (agents: ${known}); pass --agent <id>.`,
  );
}

function trimUrl(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? normalizeMcpUrl(raw) : undefined;
}

/**
 * `--url`, then FILAMENT_MCP_URL, then the server this account or the plugin already uses. A bare
 * server (`http://host:8448`) means its agents endpoint.
 */
export function resolveLoginUrl(
  pluginConfig: unknown,
  agentId: string,
  flagUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const cfg = asRecord(pluginConfig);
  const url =
    trimUrl(flagUrl) ??
    trimUrl(env.FILAMENT_MCP_URL) ??
    trimUrl(asRecord(asRecord(cfg.accounts)[agentId]).mcpUrl) ??
    trimUrl(cfg.mcpUrl) ??
    DEFAULT_MCP_URL;
  let parsed: URL;
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

/** What a login leaves on the account: the token, or a device sign-in for the gateway to finish. */
export type LoginCredential = { connectToken: string } | { pendingSignIn: PendingSignIn };

/**
 * The account install.sh writes for `OPENCLAW_AGENT=<agentId>`: account id = agent id, bound to
 * it, replacing whatever account the agent had. The account keeps `mcpUrl` only when the plugin's
 * own would point it elsewhere: the gateway may not see the environment the login ran in.
 */
export function applyLogin(
  draft: Record<string, unknown>,
  agentId: string,
  credential: LoginCredential,
  mcpUrl: string,
): { displaced: string[] } {
  const token = "connectToken" in credential ? credential.connectToken : "";
  const result = applyAgentConnect(draft, agentId, token);
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  const account = asRecord(asRecord(config.accounts)[agentId]);
  if ("pendingSignIn" in credential) {
    // No token until the owner approves: the old one belongs to the agent this login replaces.
    delete account.connectToken;
    account.pendingSignIn = credential.pendingSignIn;
  } else {
    delete account.pendingSignIn;
  }
  if (mcpUrl === (trimUrl(config.mcpUrl) ?? DEFAULT_MCP_URL)) delete account.mcpUrl;
  else account.mcpUrl = mcpUrl;
  return result;
}

export interface LoginCommandOptions {
  agent?: string;
  url?: string;
  device?: boolean;
  browser?: boolean;
  /** Commander's `--no-open`. */
  open?: boolean;
  /** Redeem the device code here instead of leaving it to the gateway. */
  wait?: boolean;
}

export interface LoginDeps extends Pick<DeviceLoginOptions, "fetch" | "sleep" | "now"> {
  gatewayConfig: unknown;
  workspace?: WorkspaceContext;
  out?: Out;
  warn?: Out;
  env?: NodeJS.ProcessEnv;
  writeConfig?: (mutate: (draft: Record<string, unknown>) => void) => Promise<boolean>;
  /** Where a pasted browser redirect is read from (browser flow). */
  pasteInput?: NodeJS.ReadableStream | null;
}

const consoleWarn: Out = (line) =>
  new Promise<void>((resolve) => {
    process.stderr.write(`${line}\n`, () => resolve());
  });

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns the exit code. The device flow, the default, ends once the code is saved: the gateway
 * redeems it (sign-in.ts), so nothing here has to outlive the shell that ran it. `--wait` and the
 * browser flow sign in here and save the token.
 */
export async function runLogin(opts: LoginCommandOptions, deps: LoginDeps): Promise<number> {
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
      deps.env ?? process.env,
    );
    await out(`Connecting OpenClaw agent "${agentId}" (${reason}).`);
    await out(`Signing in to Filament at ${mcpUrl} ...`);
    const meta = await discover(mcpUrl, fetchImpl);
    const device = opts.device || (!opts.browser && meta.deviceAuthorizationEndpoint !== undefined);

    let credential: LoginCredential;
    if (!device) {
      const token = await authorizationCodeLogin(meta, {
        fetch: fetchImpl,
        out,
        openBrowser: opts.open ?? true,
        pasteInput: deps.pasteInput,
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
    let displaced: string[] = [];
    try {
      await (deps.writeConfig ?? writeGatewayConfig)((draft) => {
        displaced = applyLogin(draft, agentId, credential, mcpUrl).displaced;
      });
    } catch (error) {
      throw new LoginError(
        `${handoff ? "The sign-in could not be handed to the gateway" : "Signed in, but the configuration could not be saved"}: ${errorText(error)}. Run the login again.`,
      );
    }
    for (const other of displaced) {
      await warn(
        `Agent '${agentId}' was bound to Filament account '${other}'; removed that account.`,
      );
    }
    if ("pendingSignIn" in credential) {
      const minutes = Math.max(
        1,
        Math.round((Date.parse(credential.pendingSignIn.expiresAt) - now()) / 60_000),
      );
      await out(`The link expires in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
      await out(
        `Approve the link above. This gateway finishes the sign-in by itself and brings '${agentId}' online; no need to keep this command running.`,
      );
      await out(`Check on it with: openclaw filament status --agent ${agentId}`);
      return 0;
    }
    await out("Connected. Configuration saved.");
    await out(
      `The gateway reloads the Filament plugin and brings '${agentId}' online; follow along with: openclaw logs --follow`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof LoginError)) throw error;
    await warn(`error: ${error.message}`);
    return 1;
  }
}

export interface StatusDeps {
  gatewayConfig: unknown;
  out?: Out;
  warn?: Out;
  now?: () => number;
  /** The plugin's state lives in the gateway's store; a CLI that cannot open it knows less. */
  loadIdentity?: (accountId: string) => AgentIdentity | undefined;
  loadSignInEnd?: (accountId: string) => SignInEnd | undefined;
}

function tryLoad<T>(load: (accountId: string) => T | undefined, accountId: string): T | undefined {
  try {
    return load(accountId);
  } catch {
    return undefined;
  }
}

/** One account's state, as `openclaw filament status` words it. */
export function describeAccount(
  pluginConfig: unknown,
  accountId: string,
  deps: Required<Pick<StatusDeps, "now" | "loadIdentity" | "loadSignInEnd">>,
): string {
  if (retiredAccountKind(pluginConfig, accountId)) return "retired; remove it from the config";
  const cfg = asRecord(pluginConfig);
  const entry = asRecord(asRecord(cfg.accounts)[accountId]);
  if (hasPendingSignIn(entry)) {
    const pending = parsePendingSignIn(entry.pendingSignIn);
    const left = pending ? Math.floor((pending.expiresAt - deps.now()) / 1000) : 0;
    return left > 0 ? `waiting for sign-in approval, expires in ${left}s` : "sign-in expired";
  }
  const token =
    hasTokenInput(entry.connectToken) ||
    (accountId === DEFAULT_ACCOUNT_ID && hasTokenInput(cfg.connectToken));
  if (token) {
    const identity = tryLoad(deps.loadIdentity, accountId);
    return identity
      ? `connected as ${identity.mxid}`
      : "signed in; waiting for the gateway to connect";
  }
  const end = tryLoad(deps.loadSignInEnd, accountId);
  if (end?.reason === "expired") return "sign-in expired";
  if (end?.reason === "denied") return "sign-in declined";
  if (end?.reason === "failed") return "sign-in failed";
  return "not signed in";
}

/**
 * One line per OpenClaw agent, then one per account bound to none. Each line starts with the
 * state, so a reader can match on it, and names its agent or account at the end.
 */
export async function runStatus(opts: { agent?: string }, deps: StatusDeps): Promise<number> {
  const out = deps.out ?? consoleOut;
  const describeDeps = {
    now: deps.now ?? Date.now,
    loadIdentity: deps.loadIdentity ?? loadIdentity,
    loadSignInEnd: deps.loadSignInEnd ?? loadSignInEnd,
  };
  const pluginConfig = pluginConfigFrom(deps.gatewayConfig);
  const agents = listGatewayAgents(deps.gatewayConfig).filter(
    (agent) => !RESERVED_ACCOUNT_IDS.has(agent.id),
  );
  let shown = agents;
  if (opts.agent !== undefined) {
    const wanted = opts.agent.trim().toLowerCase();
    shown = agents.filter((agent) => agent.id === wanted);
    if (shown.length === 0) {
      await (deps.warn ?? consoleWarn)(
        `error: This gateway has no OpenClaw agent "${wanted}" (agents: ${agents.map((a) => a.id).join(", ") || "none"}).`,
      );
      return 1;
    }
  }
  for (const agent of shown) {
    // A login's account carries the agent's id, and an ended sign-in is kept under it too.
    const accountId = agent.boundAccount ?? agent.id;
    await out(
      `${describeAccount(pluginConfig, accountId, describeDeps)} (OpenClaw agent "${agent.id}")`,
    );
  }
  if (opts.agent !== undefined) return 0;
  const claimed = new Set(agents.flatMap((agent) => [agent.boundAccount, agent.id]));
  const unbound = listConfiguredAccountIds(pluginConfig, {}).filter(
    (id) =>
      !claimed.has(id) &&
      (id !== DEFAULT_ACCOUNT_ID || hasTokenInput(asRecord(pluginConfig).connectToken)),
  );
  for (const accountId of unbound) {
    const retired = retiredAccountKind(pluginConfig, accountId);
    const role =
      retired === "control"
        ? ", a gateway control account"
        : retired === "pending"
          ? ", an agent-choice account"
          : "";
    await out(
      `${describeAccount(pluginConfig, accountId, describeDeps)} (Filament account "${accountId}"${role})`,
    );
  }
  return 0;
}

/** The slice of Commander's `Command` used here; the real type ships with OpenClaw. */
export interface CliCommand {
  command(name: string): CliCommand;
  description(text: string): CliCommand;
  option(flags: string, description: string): CliCommand;
  action(handler: (options: LoginCommandOptions) => void | Promise<void>): CliCommand;
}

export interface FilamentCliApi {
  registerCli: (
    registrar: (ctx: { program: CliCommand; config: unknown }) => void | Promise<void>,
    opts?: { descriptors?: Array<{ name: string; description: string; hasSubcommands: boolean }> },
  ) => void;
}

const ROOT_DESCRIPTION = "Connect OpenClaw agents to Filament";

export function registerFilamentCli(api: FilamentCliApi): void {
  api.registerCli(
    ({ program, config }) => {
      const root = program.command(CLI_ROOT).description(ROOT_DESCRIPTION);
      root
        .command("login")
        .description("Sign an OpenClaw agent in to Filament, with no token to paste")
        .option(
          "--agent <id>",
          "OpenClaw agent to connect (default: the one whose workspace holds the current directory, else the gateway's only agent)",
        )
        .option(
          "--url <url>",
          `Filament MCP endpoint (default: FILAMENT_MCP_URL, else ${DEFAULT_MCP_URL})`,
        )
        .option("--device", "sign in from any device with a link and a code (the default)")
        .option("--wait", "wait here for the approval instead of leaving it to the gateway")
        .option("--browser", "sign in with a browser and a local callback")
        .option("--no-open", "print the sign-in link rather than opening a browser")
        .action(async (options) => {
          process.exitCode = await runLogin(options, { gatewayConfig: config });
        });
      root
        .command("status")
        .description("Show whether each OpenClaw agent is signed in to Filament")
        .option("--agent <id>", "only this OpenClaw agent")
        .action(async (options) => {
          process.exitCode = await runStatus(options, { gatewayConfig: config });
        });
    },
    { descriptors: [{ name: CLI_ROOT, description: ROOT_DESCRIPTION, hasSubcommands: true }] },
  );
}
