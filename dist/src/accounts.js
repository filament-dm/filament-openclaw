const DEFAULT_ACCOUNT_ID = "default";
const FILAMENT_CHANNEL_ID = "filament";
const PLUGIN_ID = "filament-fcm";
const GATEWAY_ACCOUNT_ID = "gateway";
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function hasTokenInput(value) {
  return typeof value === "string" && value.trim().length > 0 || typeof value === "object" && value !== null;
}
function listConfiguredAccountIds(pluginConfig, env = process.env) {
  const cfg = asRecord(pluginConfig);
  const ids = Object.entries(asRecord(cfg.accounts)).filter(([, entry]) => hasTokenInput(asRecord(entry).connectToken)).map(([id]) => id);
  const hasDefault = hasTokenInput(cfg.connectToken) || !!env.FILAMENT_MCP_TOKEN?.trim();
  if ((hasDefault || ids.length === 0) && !ids.includes(DEFAULT_ACCOUNT_ID)) {
    ids.unshift(DEFAULT_ACCOUNT_ID);
  }
  return ids;
}
function isControlAccount(pluginConfig, accountId) {
  return asRecord(asRecord(asRecord(pluginConfig).accounts)[accountId]).control === true;
}
function pluginConfigFrom(gatewayConfig) {
  const entry = asRecord(asRecord(asRecord(gatewayConfig).plugins).entries)[PLUGIN_ID];
  return entry === void 0 ? void 0 : asRecord(entry).config;
}
function resolveToolAccountId(ctx, fallbackPluginConfig, env = process.env) {
  if (ctx.messageChannel === FILAMENT_CHANNEL_ID && ctx.agentAccountId) {
    return ctx.agentAccountId;
  }
  const gatewayConfig = ctx.getRuntimeConfig?.() ?? ctx.config;
  const bindings = asRecord(gatewayConfig).bindings;
  const ours = (Array.isArray(bindings) ? bindings : []).map(asRecord).filter((binding) => asRecord(binding.match).channel === FILAMENT_CHANNEL_ID);
  if (ctx.agentId) {
    const bound = ours.find((binding) => binding.agentId === ctx.agentId);
    if (bound) {
      const accountId = asRecord(bound.match).accountId;
      return typeof accountId === "string" && accountId !== "*" ? accountId : DEFAULT_ACCOUNT_ID;
    }
  }
  if (ours.length > 0) return null;
  const pluginConfig = pluginConfigFrom(gatewayConfig) ?? fallbackPluginConfig;
  const configured = listConfiguredAccountIds(pluginConfig, env).filter(
    (id) => !isControlAccount(pluginConfig, id)
  );
  return configured.length === 1 ? configured[0] : null;
}
export {
  DEFAULT_ACCOUNT_ID,
  FILAMENT_CHANNEL_ID,
  GATEWAY_ACCOUNT_ID,
  PLUGIN_ID,
  asRecord,
  hasTokenInput,
  isControlAccount,
  listConfiguredAccountIds,
  pluginConfigFrom,
  resolveToolAccountId
};
//# sourceMappingURL=accounts.js.map
