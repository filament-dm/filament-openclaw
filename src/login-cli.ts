/**
 * `openclaw filament login`: signs an OpenClaw agent in to Filament with OAuth (oauth-login.ts)
 * and saves the issued token as that agent's Filament account, the account install.sh writes for
 * a connect token. The write goes through the CLI (config-write.ts), an external change to the
 * running gateway, which reloads and connects the account.
 */
import { asRecord, PLUGIN_ID, pluginConfigFrom } from "./accounts.js";
import { writeGatewayConfig } from "./config-write.js";
import {
  AGENT_ID_PATTERN,
  applyAgentConnect,
  listGatewayAgents,
  RESERVED_ACCOUNT_IDS,
} from "./gateway.js";
import { consoleOut, login, LoginError, type LoginFlow, type Out } from "./oauth-login.js";
import { DEFAULT_MCP_URL } from "./settings.js";

export const CLI_ROOT = "filament";

/** The agent to sign in: the one named, or the gateway's only agent. */
export function resolveLoginAgent(gatewayConfig: unknown, requested?: string): string {
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
    return agentId;
  }
  if (agents.length === 1) return agents[0]!;
  throw new LoginError(
    agents.length === 0
      ? "This gateway has no OpenClaw agent to connect."
      : `This gateway has several OpenClaw agents (${known}); name one with --agent <id>.`,
  );
}

function trimUrl(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim().replace(/\/+$/, "") : undefined;
}

/** `--url`, then FILAMENT_MCP_URL, then the server this account or the plugin already uses. */
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

/**
 * The account install.sh writes for `OPENCLAW_AGENT=<agentId>`: account id = agent id, bound to
 * it, replacing whatever account the agent had. The account keeps `mcpUrl` only when the plugin's
 * own would point it elsewhere: the gateway may not see the environment the login ran in.
 */
export function applyLogin(
  draft: Record<string, unknown>,
  agentId: string,
  token: string,
  mcpUrl: string,
): { displaced: string[] } {
  const result = applyAgentConnect(draft, agentId, token);
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  const account = asRecord(asRecord(config.accounts)[agentId]);
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
}

export interface LoginDeps {
  gatewayConfig: unknown;
  out?: Out;
  warn?: Out;
  env?: NodeJS.ProcessEnv;
  login?: typeof login;
  writeConfig?: (mutate: (draft: Record<string, unknown>) => void) => Promise<boolean>;
}

const consoleWarn: Out = (line) =>
  new Promise<void>((resolve) => {
    process.stderr.write(`${line}\n`, () => resolve());
  });

/** Returns the exit code. */
export async function runLogin(opts: LoginCommandOptions, deps: LoginDeps): Promise<number> {
  const out = deps.out ?? consoleOut;
  const warn = deps.warn ?? consoleWarn;
  try {
    if (opts.device && opts.browser) {
      throw new LoginError("--device and --browser are mutually exclusive.");
    }
    const flow: LoginFlow = opts.device ? "device" : opts.browser ? "browser" : "auto";
    const agentId = resolveLoginAgent(deps.gatewayConfig, opts.agent);
    const mcpUrl = resolveLoginUrl(
      pluginConfigFrom(deps.gatewayConfig),
      agentId,
      opts.url,
      deps.env ?? process.env,
    );
    await out(`Signing in OpenClaw agent '${agentId}' to Filament at ${mcpUrl} ...`);
    const token = await (deps.login ?? login)(mcpUrl, {
      flow,
      out,
      openBrowser: opts.open ?? true,
    });
    await out("Signed in. Saving the configuration ...");
    let displaced: string[] = [];
    try {
      await (deps.writeConfig ?? writeGatewayConfig)((draft) => {
        displaced = applyLogin(draft, agentId, token, mcpUrl).displaced;
      });
    } catch (error) {
      throw new LoginError(
        `Signed in, but the configuration could not be saved: ${error instanceof Error ? error.message : String(error)}. Run the login again.`,
      );
    }
    for (const other of displaced) {
      await warn(
        `Agent '${agentId}' was bound to Filament account '${other}'; removed that account.`,
      );
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
        .option("--agent <id>", "OpenClaw agent to connect (default: the gateway's only agent)")
        .option(
          "--url <url>",
          `Filament MCP endpoint (default: FILAMENT_MCP_URL, else ${DEFAULT_MCP_URL})`,
        )
        .option("--device", "sign in from any device with a link and a code")
        .option("--browser", "sign in with a browser and a local callback")
        .option("--no-open", "print the sign-in link rather than opening a browser")
        .action(async (options) => {
          process.exitCode = await runLogin(options, { gatewayConfig: config });
        });
    },
    { descriptors: [{ name: CLI_ROOT, description: ROOT_DESCRIPTION, hasSubcommands: true }] },
  );
}
