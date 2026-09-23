#!/usr/bin/env bash
#
# Install and connect the filament-openclaw plugin (channel id "filament",
# plugin id "filament-fcm") into an existing OpenClaw gateway, using a
# connect token from the Filament app. Modeled on filament-hermes/install.sh.
#
#   CONNECT_TOKEN=fmcp_... bash install.sh
#
# The repository is public, so the curl-pipe-bash form works without
# credentials:
#   curl -fsSL https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/install.sh | CONNECT_TOKEN=fmcp_... bash
#
# Optional env: FILAMENT_MCP_URL (staging/local MCP endpoint instead of
# production), PLUGIN_REF (branch/tag/commit to install, default: main),
# OPENCLAW_AGENT (agent id to bind the filament channel to, when
# agents.ownership is explicit with more than one agent),
# OPENCLAW_PLUGIN_SOURCE (full override of the install spec, e.g. a future
# clawhub:... spec, instead of the git SSH/HTTPS default built from
# PLUGIN_REF).
set -euo pipefail

err()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

# --- Required/optional environment -------------------------------------------
[ -n "${CONNECT_TOKEN:-}" ] || err \
  "CONNECT_TOKEN is not set. Use the connect command shown in the Filament app."

PLUGIN_ID="filament-fcm"
PLUGIN_REF="${PLUGIN_REF:-main}"
REPO_SSH="git:git@github.com:filament-dm/filament-openclaw.git@${PLUGIN_REF}"
REPO_HTTPS="git:https://github.com/filament-dm/filament-openclaw.git@${PLUGIN_REF}"
# The repo is public: HTTPS needs no key. SSH is tried only as a fallback.
SPEC="${OPENCLAW_PLUGIN_SOURCE:-$REPO_HTTPS}"

# --- Preflight -----------------------------------------------------------------
command -v openclaw >/dev/null 2>&1 || err \
  "openclaw CLI not found on PATH. Install it first: https://docs.openclaw.ai"

# Every command below reads stdout only (2>/dev/null): the CLI's node-version
# self-restart can interleave banner text with stderr, which has been
# observed to corrupt a combined-stream JSON capture.
GATEWAY_STATUS="$(openclaw gateway status 2>/dev/null || true)"
printf '%s\n' "$GATEWAY_STATUS" | grep -q 'Runtime: running' || err \
  "OpenClaw gateway is not reachable. Start it (openclaw gateway start) or \
install it first (openclaw gateway install) — this script does not start it \
for you."

LOG_PATH="$(printf '%s\n' "$GATEWAY_STATUS" | sed -n 's/^File logs: //p' | head -n1)"
[ -n "$LOG_PATH" ] || LOG_PATH="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"

# --- Detect an existing install -------------------------------------------------
# FOUND/MISSING + trust.installSource ("git"/"path"/"npm"/...) + status, tab-sep.
LIST_JSON="$(openclaw plugins list --json 2>/dev/null || true)"
PLUGIN_STATE="$(python3 - "$LIST_JSON" "$PLUGIN_ID" <<'PY'
import json, sys
raw, pid = sys.argv[1], sys.argv[2]
try:
    data = json.loads(raw)
    for p in data.get("plugins", []):
        if p.get("id") == pid:
            src = (p.get("trust") or {}).get("installSource", "")
            print(f"FOUND\t{src}\t{p.get('status', '')}")
            sys.exit(0)
except Exception:
    pass
print("UNKNOWN\t\t")
PY
)"
IFS=$'\t' read -r FOUND_STATE INSTALL_SOURCE _CUR_STATUS <<EOF
$PLUGIN_STATE
EOF

if [ "$FOUND_STATE" = "UNKNOWN" ]; then
  # --json parse failed or produced nothing usable; fall back to a plain grep.
  if openclaw plugins list 2>/dev/null | grep -q "$PLUGIN_ID"; then
    FOUND_STATE="FOUND"; INSTALL_SOURCE=""
  else
    FOUND_STATE="MISSING"
  fi
fi

# --- Install or update the plugin -----------------------------------------------
install_fresh() {
  info "Installing $PLUGIN_ID from $SPEC ..."
  if openclaw plugins install "$SPEC" --accept-capabilities --force; then
    return 0
  fi
  if [ "$SPEC" = "$REPO_HTTPS" ]; then
    warn "HTTPS install failed; retrying over SSH."
    SPEC="$REPO_SSH"
    openclaw plugins install "$SPEC" --accept-capabilities --force \
      || err "Could not install $PLUGIN_ID from either HTTPS or SSH."
  else
    err "Could not install $PLUGIN_ID from $SPEC."
  fi
}

if [ "$FOUND_STATE" = "MISSING" ]; then
  install_fresh
elif [ "$INSTALL_SOURCE" = "git" ]; then
  # Best-effort: installSource confirms "git" but not the exact recorded
  # URL/ref, so this assumes the same filament-openclaw source and just
  # pulls the latest commit on the recorded ref. To switch branch/ref,
  # remove the plugin first or set OPENCLAW_PLUGIN_SOURCE and rerun.
  info "$PLUGIN_ID is already installed from git; updating ..."
  openclaw plugins update "$PLUGIN_ID" || err "plugin update failed for $PLUGIN_ID."
else
  info "$PLUGIN_ID is installed from a different source ($INSTALL_SOURCE); reinstalling."
  install_fresh
fi

# --- Configure (never echo the token) --------------------------------------------
info "Setting the connect token ..."
openclaw config set "plugins.entries.${PLUGIN_ID}.config.connectToken" "$CONNECT_TOKEN" \
  >/dev/null || err "could not set the connect token."

if [ -n "${FILAMENT_MCP_URL:-}" ]; then
  info "Setting the MCP URL ..."
  openclaw config set "plugins.entries.${PLUGIN_ID}.config.mcpUrl" "$FILAMENT_MCP_URL" \
    >/dev/null || err "could not set FILAMENT_MCP_URL."
fi

info "Enabling $PLUGIN_ID ..."
openclaw plugins enable "$PLUGIN_ID" --accept-capabilities \
  || err "could not enable $PLUGIN_ID."

# --- Binding: pick which agent receives filament channel messages ---------------
AGENTS_JSON="$(openclaw config get agents --json 2>/dev/null || true)"
read -r OWNERSHIP AGENT_IDS_CSV <<EOF
$(python3 - "$AGENTS_JSON" <<'PY'
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    d = {}
ownership = d.get("ownership", "implicit")
ids = list((d.get("entries") or {}).keys())
print(ownership, ",".join(ids) if ids else "-")
PY
)
EOF

AGENT_COUNT="$(printf '%s\n' "$AGENT_IDS_CSV" | tr ',' '\n' | wc -l | tr -d ' ')"
NEED_BINDING=1
[ "$OWNERSHIP" = "explicit" ] && [ "$AGENT_IDS_CSV" != "-" ] && [ "$AGENT_COUNT" -gt 1 ] || NEED_BINDING=0

if [ "$NEED_BINDING" = 1 ]; then
  if [ -n "${OPENCLAW_AGENT:-}" ]; then
    TARGET_AGENT="$OPENCLAW_AGENT"
    printf '%s\n' "$AGENT_IDS_CSV" | tr ',' '\n' | grep -qx "$TARGET_AGENT" || err \
      "OPENCLAW_AGENT='$TARGET_AGENT' is not a known agent id. Known agents: $AGENT_IDS_CSV"
  elif [ -r /dev/tty ]; then
    printf 'Multiple agents (%s). Which should receive Filament messages? Agent id: ' \
      "$AGENT_IDS_CSV" > /dev/tty
    read -r TARGET_AGENT < /dev/tty
    printf '%s\n' "$AGENT_IDS_CSV" | tr ',' '\n' | grep -qx "$TARGET_AGENT" || err \
      "'$TARGET_AGENT' is not one of: $AGENT_IDS_CSV"
  else
    err "agents.ownership is explicit with multiple agents ($AGENT_IDS_CSV) and no \
tty is available to prompt. Re-run with OPENCLAW_AGENT=<agent-id>."
  fi

  info "Binding the filament channel to agent '$TARGET_AGENT' ..."
  EXISTING_BINDINGS="$(openclaw config get bindings --json 2>/dev/null || true)"
  MERGED_BINDINGS="$(python3 - "$EXISTING_BINDINGS" "$TARGET_AGENT" <<'PY'
import json, sys
raw, agent_id = sys.argv[1], sys.argv[2]
try:
    existing = json.loads(raw)
    if not isinstance(existing, list):
        existing = []
except Exception:
    existing = []
def is_ours(b):
    m = b.get("match") or {}
    return m.get("channel") == "filament" and m.get("accountId") == "default"
merged = [b for b in existing if not is_ours(b)]
merged.append({"agentId": agent_id, "match": {"channel": "filament", "accountId": "default"}})
print(json.dumps(merged))
PY
)"
  openclaw config set bindings "$MERGED_BINDINGS" --strict-json >/dev/null \
    || err "could not write the filament channel binding."
else
  info "Single/implicit agent ownership; no explicit binding needed."
fi

# --- Verify ------------------------------------------------------------------
info "Waiting for $PLUGIN_ID to load and connect (up to 60s) ..."
DEADLINE=$(( $(date +%s) + 60 ))
STATUS=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  RUNTIME_JSON="$(openclaw plugins inspect "$PLUGIN_ID" --runtime --json 2>/dev/null || true)"
  STATUS="$(printf '%s' "$RUNTIME_JSON" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("plugin", {}).get("status", ""))
except Exception:
    print("")' 2>/dev/null || true)"
  [ "$STATUS" = "loaded" ] && break
  sleep 3
done

CONNECTED=0
PRINCIPAL=""
if [ -n "$LOG_PATH" ] && [ -r "$LOG_PATH" ] \
    && grep -Eq 'connect token exchanged for a bearer|persisted bearer found' "$LOG_PATH"; then
  CONNECTED=1
  PRINCIPAL="$(grep -E 'filament-connect: identity' "$LOG_PATH" | tail -n1 \
    | sed -n 's/.*principal=\([^ "\\]*\).*/\1/p')"
fi

if [ "$STATUS" = "loaded" ] && [ "$CONNECTED" = 1 ]; then
  info "Connected. $PLUGIN_ID is loaded and running.${PRINCIPAL:+ Principal: $PRINCIPAL.}"
else
  warn "Install/config finished, but the connection was not confirmed within 60s. \
Follow along with: openclaw logs --follow"
fi
