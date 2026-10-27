import { asRecord } from "./accounts.js";
function parseIdentityMarkdown(text) {
  const identity = {};
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^\s*-\s*/, "");
    const colon = cleaned.indexOf(":");
    if (colon === -1) continue;
    const label = cleaned.slice(0, colon).replace(/[*_`]/g, "").trim().toLowerCase();
    const value = cleaned.slice(colon + 1).replace(/^[*_`\s]+|[*_`\s]+$/g, "").trim();
    if (!value || value.startsWith("(") && value.endsWith(")")) continue;
    if (label === "name" && identity.name === void 0) identity.name = value;
    if (label === "emoji" && identity.emoji === void 0) identity.emoji = value;
  }
  return identity;
}
function seedName(gatewayConfig, agentId, identityFile) {
  const entry = asRecord(asRecord(asRecord(asRecord(gatewayConfig).agents).entries)[agentId]);
  const text = (value) => typeof value === "string" && value.trim() ? value.trim() : void 0;
  const candidates = [
    text(asRecord(entry.identity).name),
    text(identityFile?.name),
    text(entry.name)
  ];
  const named = candidates.find(
    (name) => name !== void 0 && name.toLowerCase() !== agentId.toLowerCase()
  );
  if (named) return named;
  return agentId === "main" ? void 0 : agentId;
}
function normalizeName(name) {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}
function isDefaultAgentName(displayName, ownerName) {
  if (typeof displayName !== "string" || !displayName.trim()) return true;
  const name = normalizeName(displayName);
  const bases = ["my agent"];
  if (typeof ownerName === "string" && ownerName.trim()) {
    bases.push(`${normalizeName(ownerName)}'s agent`);
  }
  return bases.some(
    (base) => name === base || new RegExp(`^${escapeRegex(base)} \\d+$`).test(name)
  );
}
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};
async function avatarImage(ctx) {
  const { avatar, client, signal } = ctx;
  if (avatar.kind === "remote") return avatar.url;
  if (avatar.kind === "data") {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(avatar.url);
    if (!match || !match[1].startsWith("image/")) return void 0;
    const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return client.uploadMedia(bytes, match[1], void 0, { signal });
  }
  if (avatar.kind === "local") {
    const extension = avatar.filePath.slice(avatar.filePath.lastIndexOf(".")).toLowerCase();
    const contentType = MIME_BY_EXTENSION[extension];
    if (!contentType) return void 0;
    const filename = avatar.filePath.split(/[\\/]/).pop();
    return client.uploadMedia(await ctx.readFile(avatar.filePath), contentType, filename, {
      signal
    });
  }
  return void 0;
}
function setProfileError(result) {
  if (!result.ok) return result.error?.message ?? result.kind ?? "failed";
  const error = asRecord(result.data).error;
  return typeof error === "string" && error ? error : void 0;
}
const NAME_ATTEMPTS = 5;
async function setName(ctx, wanted) {
  for (let n = 1; n <= NAME_ATTEMPTS; n++) {
    const candidate = n === 1 ? wanted : `${wanted} ${n}`;
    const refused = setProfileError(
      await ctx.client.callTool("set_profile", { name: candidate }, { signal: ctx.signal })
    );
    if (!refused) return candidate;
    if (!/already uses that name|name.*taken/i.test(refused)) {
      ctx.log(`filament-profile: the name "${candidate}" was refused: ${refused}`);
      return void 0;
    }
  }
  ctx.log(`filament-profile: "${wanted}" and its numbered forms are all taken; name left as is`);
  return void 0;
}
async function seedProfile(ctx) {
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
    let name;
    if (ctx.name && ctx.name !== data.display_name) {
      name = await setName(ctx, ctx.name);
    }
    let image = false;
    if (ctx.avatar.kind === "none") {
      log("filament-profile: the OpenClaw agent has no avatar");
    } else {
      let source;
      try {
        source = await avatarImage(ctx);
      } catch (error) {
        log(`filament-profile: could not upload the avatar: ${String(error)}`);
      }
      if (source === void 0) {
        log(
          `filament-profile: the OpenClaw agent's avatar (${ctx.avatar.kind}) is not an image Filament takes`
        );
      } else {
        const refused = setProfileError(
          await client.callTool("set_profile", { image: source }, { signal })
        );
        if (refused) log(`filament-profile: the avatar was refused: ${refused}`);
        else image = true;
      }
    }
    if (name === void 0 && !image) return null;
    log(
      `filament-profile: set ${[name ? `the name "${name}"` : "", image ? "the avatar" : ""].filter(Boolean).join(" and ")} from the OpenClaw agent`
    );
    return { ...name ? { name } : {}, image };
  } catch (error) {
    log(`filament-profile: ${String(error)}`);
    return null;
  }
}
export {
  isDefaultAgentName,
  parseIdentityMarkdown,
  seedName,
  seedProfile,
  setProfileError
};
