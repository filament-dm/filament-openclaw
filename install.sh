#!/usr/bin/env bash
#
# Connect one Filament agent to an OpenClaw agent on this gateway, installing
# the filament-openclaw plugin (channel id "filament", plugin id
# "filament-fcm") the first time. Modeled on filament-hermes/install.sh.
#
#   CONNECT_TOKEN=fmcp_... OPENCLAW_AGENT=researcher bash install.sh
#
# The repository is public, so the curl-pipe-bash form works without
# credentials:
#   curl -fsSL https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/install.sh \
#     | CONNECT_TOKEN=fmcp_... OPENCLAW_AGENT=researcher bash
#
# Idempotent, and meant to be run once per Filament agent:
#   1. installs the plugin only if the gateway doesn't have it (an existing
#      install — git, npm or a --link dev checkout — is left alone);
#   2. creates the OpenClaw agent OPENCLAW_AGENT if the gateway lacks it, and
#      binds it to its own channel account (account id = agent id), holding
#      this CONNECT_TOKEN under plugins.entries.filament-fcm.config.accounts;
#   3. waits for that account to connect, so the Filament app flips to online.
# Re-running with the same token changes nothing; with a new token it
# replaces the one this agent had.
#
# One Filament agent per OpenClaw agent: binding this account to an agent
# first drops whatever Filament account that agent had, and removes that
# account's token (an unbound account would silently land on the system
# agent instead).
#
# OPENCLAW_GATEWAY=1 (instead of OPENCLAW_AGENT) pairs the gateway itself: the
# token becomes a "gateway" control account the Filament app then drives to
# connect this gateway's agents with no further terminal step.
#
# Optional env: FILAMENT_MCP_URL (staging/local MCP endpoint instead of
# production), PLUGIN_REF (branch/tag/commit to install, default: main),
# OPENCLAW_PLUGIN_SOURCE (full override of the install spec),
# FILAMENT_PLUGIN_UPDATE=1 (update an already-installed plugin).
# Without OPENCLAW_AGENT the script keeps its single-agent behavior: the
# token becomes the "default" account, bound only when the gateway has
# several agents (prompting on a tty, or failing without one).
set -euo pipefail

err()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

# --- Required/optional environment -------------------------------------------
[ -n "${CONNECT_TOKEN:-}" ] || err \
  "CONNECT_TOKEN is not set. Use the connect command shown in the Filament app."
export CONNECT_TOKEN

PLUGIN_ID="filament-fcm"
PLUGIN_REF="${PLUGIN_REF:-main}"
REPO_SSH="git:git@github.com:filament-dm/filament-openclaw.git@${PLUGIN_REF}"
REPO_HTTPS="git:https://github.com/filament-dm/filament-openclaw.git@${PLUGIN_REF}"
# The repo is public: HTTPS needs no key. SSH is tried only as a fallback.
SPEC="${OPENCLAW_PLUGIN_SOURCE:-$REPO_HTTPS}"

# OpenClaw agent ids are lowercase; the Filament app already sends a slug.
TARGET_AGENT="$(printf '%s' "${OPENCLAW_AGENT:-}" | tr '[:upper:]' '[:lower:]')"
# OPENCLAW_GATEWAY=1 pairs the gateway instead: the token becomes the
# "gateway" control account, which no OpenClaw agent is bound to and which
# takes connect commands from the Filament app (src/gateway.ts).
GATEWAY_MODE=0
[ "${OPENCLAW_GATEWAY:-}" = "1" ] && GATEWAY_MODE=1
if [ "$GATEWAY_MODE" = 1 ]; then
  [ -z "$TARGET_AGENT" ] || err "OPENCLAW_GATEWAY=1 and OPENCLAW_AGENT are mutually exclusive."
  ACCOUNT_ID="gateway"
elif [ -n "$TARGET_AGENT" ]; then
  printf '%s' "$TARGET_AGENT" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,63}$' || err \
    "OPENCLAW_AGENT='$OPENCLAW_AGENT' is not a valid agent id (lowercase letters, digits, - and _)."
  ACCOUNT_ID="$TARGET_AGENT"
else
  ACCOUNT_ID="default"
fi

# --- Preflight -----------------------------------------------------------------
command -v openclaw >/dev/null 2>&1 || err \
  "openclaw CLI not found on PATH. Install it first: https://docs.openclaw.ai"
command -v python3 >/dev/null 2>&1 || err "python3 not found on PATH."

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
# Only log lines written after this point count as this run's connection.
LOG_START_LINE=0
[ -r "$LOG_PATH" ] && LOG_START_LINE="$(wc -l < "$LOG_PATH" | tr -d ' ')"

# --- 1. The plugin: install only when missing ------------------------------------
# FOUND/MISSING + trust.installSource ("git"/"path"/"npm"/...) + enabled, tab-sep.
LIST_JSON="$(openclaw plugins list --json 2>/dev/null || true)"
PLUGIN_STATE="$(python3 - "$LIST_JSON" "$PLUGIN_ID" <<'PY'
import json, sys
raw, pid = sys.argv[1], sys.argv[2]
try:
    data = json.loads(raw)
    for p in data.get("plugins", []):
        if p.get("id") == pid:
            src = (p.get("trust") or {}).get("installSource", "")
            print(f"FOUND\t{src or '-'}\t{'1' if p.get('enabled') else '0'}")
            sys.exit(0)
    print("MISSING\t-\t0")
except Exception:
    print("UNKNOWN\t-\t0")
PY
)"
IFS=$'\t' read -r FOUND_STATE INSTALL_SOURCE PLUGIN_ENABLED <<EOF
$PLUGIN_STATE
EOF

if [ "$FOUND_STATE" = "UNKNOWN" ]; then
  # --json parse failed; fall back to a plain grep.
  if openclaw plugins list 2>/dev/null | grep -q "$PLUGIN_ID"; then
    FOUND_STATE="FOUND"
  else
    FOUND_STATE="MISSING"
  fi
fi

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
  PLUGIN_ENABLED=0
elif [ "${FILAMENT_PLUGIN_UPDATE:-}" = "1" ]; then
  if [ "$INSTALL_SOURCE" = "git" ]; then
    info "Updating $PLUGIN_ID (installed from git) ..."
    openclaw plugins update "$PLUGIN_ID" || err "plugin update failed for $PLUGIN_ID."
  else
    info "Reinstalling $PLUGIN_ID (installed from $INSTALL_SOURCE) ..."
    install_fresh
  fi
else
  info "$PLUGIN_ID is already installed (${INSTALL_SOURCE}); reusing it."
fi

# --- 2. The agent: create it if missing -------------------------------------------
AGENTS_JSON="$(openclaw config get agents --json 2>/dev/null || true)"
AGENT_LIST_JSON="$(openclaw agents list --json 2>/dev/null || true)"
read -r OWNERSHIP AGENT_IDS_CSV WORKSPACE_ROOT <<EOF
$(python3 - "$AGENTS_JSON" "$AGENT_LIST_JSON" <<'PY'
import json, os, sys
try:
    cfg = json.loads(sys.argv[1])
except Exception:
    cfg = {}
try:
    listed = json.loads(sys.argv[2])
except Exception:
    listed = []
ids = [a.get("id") for a in listed if isinstance(a, dict) and a.get("id")]
ids = ids or list((cfg.get("entries") or {}).keys())
# New agents sit next to the existing ones' workspaces.
roots = [os.path.dirname(a["workspace"]) for a in listed
         if isinstance(a, dict) and a.get("workspace")]
root = roots[0] if roots else os.path.expanduser("~/.openclaw/workspace")
print(cfg.get("ownership", "implicit"), ",".join(ids) if ids else "-", root)
PY
)
EOF

agent_known() { printf '%s\n' "$AGENT_IDS_CSV" | tr ',' '\n' | grep -qx "$1"; }

if [ "$GATEWAY_MODE" = 1 ]; then
  info "Pairing this gateway with Filament (agents: $AGENT_IDS_CSV)."
elif [ -n "$TARGET_AGENT" ]; then
  if agent_known "$TARGET_AGENT"; then
    info "Using the existing OpenClaw agent '$TARGET_AGENT'."
  else
    info "Creating the OpenClaw agent '$TARGET_AGENT' ..."
    openclaw agents add "$TARGET_AGENT" \
      --workspace "$WORKSPACE_ROOT/$TARGET_AGENT" --non-interactive >/dev/null \
      || err "could not create the OpenClaw agent '$TARGET_AGENT'."
    OWNERSHIP="explicit"
  fi
else
  # Single-agent behavior: bind the default account only when routing needs it.
  AGENT_COUNT="$(printf '%s\n' "$AGENT_IDS_CSV" | tr ',' '\n' | grep -c . || true)"
  if [ "$OWNERSHIP" = "explicit" ] && [ "$AGENT_COUNT" -gt 1 ]; then
    if [ -r /dev/tty ]; then
      printf 'Multiple agents (%s). Which should receive Filament messages? Agent id: ' \
        "$AGENT_IDS_CSV" > /dev/tty
      read -r TARGET_AGENT < /dev/tty
      agent_known "$TARGET_AGENT" || err "'$TARGET_AGENT' is not one of: $AGENT_IDS_CSV"
    else
      err "agents.ownership is explicit with multiple agents ($AGENT_IDS_CSV) and no \
tty is available to prompt. Re-run with OPENCLAW_AGENT=<agent-id>."
    fi
  fi
fi

# --- 2b. Token + binding, in one validated config write --------------------------
# The token travels through the environment into the patch on stdin, never argv.
BINDINGS_JSON="$(openclaw config get bindings --json 2>/dev/null || true)"
PLUGIN_CFG_JSON="$(openclaw config get "plugins.entries.${PLUGIN_ID}.config" --json 2>/dev/null || true)"
PATCH_AND_NOTES="$(python3 - "$BINDINGS_JSON" "$PLUGIN_CFG_JSON" "$ACCOUNT_ID" "$TARGET_AGENT" "$PLUGIN_ID" "$GATEWAY_MODE" <<'PY'
import json, os, sys
raw_bindings, raw_cfg, account, agent, plugin_id, gateway_mode = sys.argv[1:7]
def load(raw, default):
    try:
        v = json.loads(raw)
        return v if isinstance(v, type(default)) else default
    except Exception:
        return default
bindings = load(raw_bindings, [])
cfg = load(raw_cfg, {})
token = os.environ["CONNECT_TOKEN"]
mcp_url = os.environ.get("FILAMENT_MCP_URL", "").strip()

plugin_cfg = {}
if account == "default":
    plugin_cfg["connectToken"] = token
elif gateway_mode == "1":
    plugin_cfg["accounts"] = {account: {"connectToken": token, "control": True}}
else:
    plugin_cfg["accounts"] = {account: {"connectToken": token}}
if mcp_url:
    plugin_cfg["mcpUrl"] = mcp_url

patch = {"plugins": {"entries": {plugin_id: {"config": plugin_cfg}}}}
notes = []
if agent:
    def ours(b):
        return isinstance(b, dict) and (b.get("match") or {}).get("channel") == "filament"
    displaced = set()
    kept = []
    for b in bindings:
        if ours(b) and (b.get("agentId") == agent or (b.get("match") or {}).get("accountId", "default") == account):
            other = (b.get("match") or {}).get("accountId", "default")
            if b.get("agentId") == agent and other != account:
                displaced.add(other)
            if other == account and b.get("agentId") != agent:
                notes.append(f"Moved Filament account '{account}' off agent '{b.get('agentId')}'.")
            continue
        kept.append(b)
    kept.append({"agentId": agent, "match": {"channel": "filament", "accountId": account}})
    patch["bindings"] = kept
    for other in sorted(displaced):
        if other == "default":
            plugin_cfg["connectToken"] = None
        else:
            plugin_cfg.setdefault("accounts", {})[other] = None
        notes.append(f"Agent '{agent}' was bound to Filament account '{other}'; removed that account.")
print(json.dumps(patch))
for n in notes:
    print(n)
PY
)"
PATCH="$(printf '%s\n' "$PATCH_AND_NOTES" | head -n1)"
printf '%s\n' "$PATCH_AND_NOTES" | tail -n +2 | while IFS= read -r note; do
  [ -n "$note" ] && warn "$note"
done

info "Saving the connect token${TARGET_AGENT:+ and binding agent '$TARGET_AGENT' to Filament account '$ACCOUNT_ID'} ..."
REPLACE_ARGS=()
[ -n "$TARGET_AGENT" ] && REPLACE_ARGS=(--replace-path bindings)
# ${arr[@]+...}: bash 3.2 (macOS) treats an empty array as unset under set -u.
printf '%s' "$PATCH" | openclaw config patch --stdin ${REPLACE_ARGS[@]+"${REPLACE_ARGS[@]}"} >/dev/null \
  || err "could not write the Filament account config (openclaw config patch failed)."

if [ "$PLUGIN_ENABLED" != "1" ]; then
  info "Enabling $PLUGIN_ID ..."
  openclaw plugins enable "$PLUGIN_ID" --accept-capabilities \
    || err "could not enable $PLUGIN_ID."
fi

# --- 3. Verify this account connected -------------------------------------------
# channel.ts prefixes every account's log line with "[<account id>]".
info "Waiting for Filament account '$ACCOUNT_ID' to connect (up to 90s) ..."
DEADLINE=$(( $(date +%s) + 90 ))
CONNECTED=0
PRINCIPAL=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ -r "$LOG_PATH" ]; then
    LINE="$(tail -n +"$((LOG_START_LINE + 1))" "$LOG_PATH" \
      | grep -F "filament-connect: identity account=${ACCOUNT_ID} " | tail -n1 || true)"
    if [ -n "$LINE" ]; then
      CONNECTED=1
      PRINCIPAL="$(printf '%s' "$LINE" | sed -n 's/.*principal=\([^ "\\]*\).*/\1/p')"
      break
    fi
  fi
  sleep 3
done

if [ "$CONNECTED" = 1 ] && [ "$GATEWAY_MODE" = 1 ]; then
  info "Gateway paired.${PRINCIPAL:+ Principal: $PRINCIPAL.} Pick which agents to connect in the Filament app."
elif [ "$CONNECTED" = 1 ]; then
  info "Connected.${TARGET_AGENT:+ OpenClaw agent '$TARGET_AGENT' is live on Filament.}${PRINCIPAL:+ Principal: $PRINCIPAL.}"
  info "Say hi to it from the Filament app."
else
  warn "Config written, but account '$ACCOUNT_ID' did not report a connection within \
90s. Follow along with: openclaw logs --follow"
fi
