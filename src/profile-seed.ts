/**
 * A new Filament agent arrives named "<Owner>'s agent" (numbered from the second), with no
 * picture. On its first connect the plugin gives it the bound OpenClaw agent's name and avatar,
 * in code, before the first hello. A name the owner already chose in the app is kept: only the
 * server's default is replaced, and a picture only where there is none. Filament has no emoji
 * avatar an agent can set, so an identity emoji is not carried over.
 */
import { asRecord } from "./accounts.js";
import type { ToolCallResult } from "./mcp-client.js";

/** OpenClaw's own resolution of an agent's avatar (config identity, then IDENTITY.md). */
export type AvatarSource =
  | { kind: "none" }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string }
  | { kind: "local"; filePath: string };

/** The `- Label: value` lines OpenClaw reads from a workspace's IDENTITY.md. */
export function parseIdentityMarkdown(text: string): { name?: string; emoji?: string } {
  const identity: { name?: string; emoji?: string } = {};
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^\s*-\s*/, "");
    const colon = cleaned.indexOf(":");
    if (colon === -1) continue;
    const label = cleaned.slice(0, colon).replace(/[*_`]/g, "").trim().toLowerCase();
    const value = cleaned
      .slice(colon + 1)
      .replace(/^[*_`\s]+|[*_`\s]+$/g, "")
      .trim();
    // The template's unfilled hints read "(pick something you like)".
    if (!value || (value.startsWith("(") && value.endsWith(")"))) continue;
    if (label === "name" && identity.name === undefined) identity.name = value;
    if (label === "emoji" && identity.emoji === undefined) identity.emoji = value;
  }
  return identity;
}

/**
 * The name to give the Filament agent: the OpenClaw identity's name, then IDENTITY.md's, then the
 * entry's, then the agent id. A value that only repeats the id counts for nothing ahead of a real
 * one, and OpenClaw's stock `main` never becomes a name: the server's default says more.
 */
export function seedName(
  gatewayConfig: unknown,
  agentId: string,
  identityFile?: { name?: string },
): string | undefined {
  const entry = asRecord(asRecord(asRecord(asRecord(gatewayConfig).agents).entries)[agentId]);
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const candidates = [
    text(asRecord(entry.identity).name),
    text(identityFile?.name),
    text(entry.name),
  ];
  const named = candidates.find(
    (name): name is string => name !== undefined && name.toLowerCase() !== agentId.toLowerCase(),
  );
  if (named) return named;
  return agentId === "main" ? undefined : agentId;
}

function normalizeName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The server's default: "<Owner>'s agent", "<Owner>'s agent 2", …, or "My agent …" unnamed. */
export function isDefaultAgentName(displayName: unknown, ownerName: unknown): boolean {
  if (typeof displayName !== "string" || !displayName.trim()) return true;
  const name = normalizeName(displayName);
  const bases = ["my agent"];
  if (typeof ownerName === "string" && ownerName.trim()) {
    bases.push(`${normalizeName(ownerName)}'s agent`);
  }
  return bases.some(
    (base) => name === base || new RegExp(`^${escapeRegex(base)} \\d+$`).test(name),
  );
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export interface SeedClient {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<ToolCallResult>;
  uploadMedia(
    bytes: Uint8Array,
    contentType: string,
    filename: string | undefined,
    opts?: { signal?: AbortSignal },
  ): Promise<string>;
}

export interface SeedContext {
  client: SeedClient;
  name: string | undefined;
  avatar: AvatarSource;
  readFile: (path: string) => Promise<Uint8Array>;
  log: (message: string) => void;
  signal?: AbortSignal;
}

/** The `image` for set_profile: an mxc url once uploaded, or a URL the server fetches itself. */
async function avatarImage(ctx: SeedContext): Promise<string | undefined> {
  const { avatar, client, signal } = ctx;
  if (avatar.kind === "remote") return avatar.url;
  if (avatar.kind === "data") {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(avatar.url);
    if (!match || !match[1]!.startsWith("image/")) return undefined;
    const bytes = match[2]
      ? Buffer.from(match[3]!, "base64")
      : Buffer.from(decodeURIComponent(match[3]!), "utf8");
    return client.uploadMedia(bytes, match[1]!, undefined, { signal });
  }
  if (avatar.kind === "local") {
    const extension = avatar.filePath.slice(avatar.filePath.lastIndexOf(".")).toLowerCase();
    const contentType = MIME_BY_EXTENSION[extension];
    if (!contentType) return undefined;
    const filename = avatar.filePath.split(/[\\/]/).pop();
    return client.uploadMedia(await ctx.readFile(avatar.filePath), contentType, filename, {
      signal,
    });
  }
  return undefined;
}

export interface SeedResult {
  /** The name the profile now has, when this set it. */
  name?: string;
  image: boolean;
}

/** Never throws: a profile it cannot seed stays as the server made it. */
export async function seedProfile(ctx: SeedContext): Promise<SeedResult | null> {
  const { client, log, signal } = ctx;
  try {
    const self = await client.callTool("get_self", {}, { signal });
    if (!self.ok) {
      log(`filament-profile: get_self failed (${self.error?.message ?? "?"}); profile left as is`);
      return null;
    }
    const data = asRecord(self.data);
    if (!isDefaultAgentName(data.display_name, asRecord(data.owner).display_name)) {
      log("filament-profile: the owner named this agent; profile left as is");
      return null;
    }
    const args: Record<string, string> = {};
    if (ctx.name && ctx.name !== data.display_name) args.name = ctx.name;
    const hasPicture = typeof data.avatar_url === "string" && data.avatar_url !== "";
    if (!hasPicture && ctx.avatar.kind !== "none") {
      try {
        const image = await avatarImage(ctx);
        if (image) args.image = image;
      } catch (error) {
        log(`filament-profile: could not upload the avatar: ${String(error)}`);
      }
    }
    if (Object.keys(args).length === 0) return null;
    const set = await client.callTool("set_profile", args, { signal });
    if (!set.ok) {
      log(`filament-profile: set_profile failed (${set.error?.message ?? "?"})`);
      return null;
    }
    log(
      `filament-profile: set ${[args.name ? "the name" : "", args.image ? "the avatar" : ""].filter(Boolean).join(" and ")} from the OpenClaw agent`,
    );
    return { ...(args.name ? { name: args.name } : {}), image: args.image !== undefined };
  } catch (error) {
    log(`filament-profile: ${String(error)}`);
    return null;
  }
}
