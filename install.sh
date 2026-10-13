#!/usr/bin/env bash
#
# Install the Filament plugin into this OpenClaw gateway and connect an agent.
#
#   curl -fsSL https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/install.sh | bash
#   openclaw filament login --agent <agent id>
#
# Without CONNECT_TOKEN it installs and enables the plugin only; the login
# command then signs the agent in to Filament in a browser, no token to paste.
# With the token from the Filament app it also connects that agent:
#
#   curl -fsSL https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/install.sh \
#     | CONNECT_TOKEN=fmcp_... bash
#
# What it does, safe to re-run:
#   1. installs the plugin if the gateway doesn't have it (an existing install
#      is left alone, unless it predates what this run needs);
#   2. with a token, saves it as the Filament account of OPENCLAW_AGENT (created
#      if missing), or of the gateway's only agent when it names none;
#   3. with a token, waits until that account is connected.
# One Filament agent per OpenClaw agent: connecting a new one replaces the old.
#
# Environment:
#   CONNECT_TOKEN           token from the Filament app (optional; without it,
#                           connect with `openclaw filament login`)
#   OPENCLAW_AGENT          OpenClaw agent the token connects (default: the gateway's
#                           only agent; required when it has several)
#   FILAMENT_MCP_URL        a non-production Filament server
#   FILAMENT_TRANSPORT      poll (default) or fcm
#   FILAMENT_FIREBASE_PROJECT_ID, _API_KEY, _APP_ID, _SENDER_ID
#                           Firebase project of a non-production server (fcm)
#   PLUGIN_REF              branch, tag or commit to install (default: main)
#   OPENCLAW_PLUGIN_SOURCE  full plugin install spec, overriding PLUGIN_REF
#   FILAMENT_PLUGIN_UPDATE=1  update an installed plugin
set -euo pipefail

err()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

# --- Optional environment ------------------------------------------------------
# Without a token: install and enable only; `openclaw filament login` connects.
TOKEN_MODE=0
[ -n "${CONNECT_TOKEN:-}" ] && TOKEN_MODE=1
export CONNECT_TOKEN="${CONNECT_TOKEN:-}"

PLUGIN_ID="filament-openclaw"
PLUGIN_REF="${PLUGIN_REF:-main}"
REPO_SSH="git:git@github.com:filament-dm/filament-openclaw.git@${PLUGIN_REF}"
REPO_HTTPS="git:https://github.com/filament-dm/filament-openclaw.git@${PLUGIN_REF}"
# The repo is public: HTTPS needs no key. SSH is tried only as a fallback.
SPEC="${OPENCLAW_PLUGIN_SOURCE:-$REPO_HTTPS}"

command -v python3 >/dev/null 2>&1 || err "python3 not found on PATH."

[ -z "${OPENCLAW_GATEWAY:-}" ] || err \
  "OPENCLAW_GATEWAY is gone: connect each agent with 'openclaw filament login --agent <id>'."

# OpenClaw agent ids are lowercase.
TARGET_AGENT="$(printf '%s' "${OPENCLAW_AGENT:-}" | tr '[:upper:]' '[:lower:]')"
if [ -n "$TARGET_AGENT" ]; then
  printf '%s' "$TARGET_AGENT" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,63}$' || err \
    "OPENCLAW_AGENT='$OPENCLAW_AGENT' is not a valid agent id (lowercase letters, digits, - and _)."
fi

TRANSPORT="$(printf '%s' "${FILAMENT_TRANSPORT:-}" | tr '[:upper:]' '[:lower:]')"
case "$TRANSPORT" in
  ""|fcm|poll) ;;
  *) err "FILAMENT_TRANSPORT='$FILAMENT_TRANSPORT' is not a transport (poll or fcm)." ;;
esac
export TRANSPORT

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
# Only log lines written after this point count as this run's connection.
LOG_START_LINE=0
[ -r "$LOG_PATH" ] && LOG_START_LINE="$(wc -l < "$LOG_PATH" | tr -d ' ')"

# --- 1. The plugin: install only when missing ------------------------------------
# FOUND/MISSING + trust.installSource ("git"/"path"/"npm"/...) + enabled + whether the
# installed manifest has `openclaw filament login`, tab-sep.
LIST_JSON="$(openclaw plugins list --json 2>/dev/null || true)"
PLUGIN_STATE="$(python3 - "$LIST_JSON" "$PLUGIN_ID" <<'PY'
import json, os, sys
raw, pid = sys.argv[1], sys.argv[2]
try:
    data = json.loads(raw)
    for p in data.get("plugins", []):
        if p.get("id") == pid:
            src = (p.get("trust") or {}).get("installSource", "")
            login = "0"
            try:
                with open(os.path.join(p.get("rootDir", ""), "openclaw.plugin.json")) as f:
                    manifest = json.load(f)
                # An install from before `openclaw filament login` has no such command.
                if "filament" in ((manifest.get("activation") or {}).get("onCommands") or []):
                    login = "1"
            except Exception:
                pass
            print(f"FOUND\t{src or '-'}\t{'1' if p.get('enabled') else '0'}\t{login}")
            sys.exit(0)
    print("MISSING\t-\t0\t0")
except Exception:
    print("UNKNOWN\t-\t0\t0")
PY
)"
IFS=$'\t' read -r FOUND_STATE INSTALL_SOURCE PLUGIN_ENABLED SUPPORTS_LOGIN <<EOF
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

# The install's output is shown and kept, to tell a failed download from a
# plugin that was downloaded but that the gateway would not load.
INSTALL_LOG="$(mktemp)"
trap 'rm -f "$INSTALL_LOG"' EXIT

plugin_install() {
  openclaw plugins install "$1" --accept-capabilities --force 2>&1 | tee "$INSTALL_LOG"
}

# Another source fetches the same code, so a load failure is not worth a retry.
fail_if_load_failed() {
  grep -qE 'plugin load failed|failed during activate' "$INSTALL_LOG" || return 0
  err "$PLUGIN_ID was downloaded, but the gateway could not load it (see the error above). \
This is a bug in the plugin version from $SPEC, not in your setup. Try a known-good \
version with PLUGIN_REF=<tag or commit>, then run: openclaw plugins reload $PLUGIN_ID"
}

install_fresh() {
  info "Installing $PLUGIN_ID from $SPEC ..."
  plugin_install "$SPEC" && return 0
  fail_if_load_failed
  if [ "$SPEC" = "$REPO_HTTPS" ]; then
    warn "HTTPS install failed; retrying over SSH."
    SPEC="$REPO_SSH"
    plugin_install "$SPEC" && return 0
    fail_if_load_failed
    err "Could not install $PLUGIN_ID from either HTTPS or SSH."
  else
    err "Could not install $PLUGIN_ID from $SPEC."
  fi
}

if [ "$FOUND_STATE" = "MISSING" ]; then
  install_fresh
  PLUGIN_ENABLED=0
elif [ "${FILAMENT_PLUGIN_UPDATE:-}" = "1" ] || [ "$SUPPORTS_LOGIN" != 1 ]; then
  [ "${FILAMENT_PLUGIN_UPDATE:-}" = "1" ] \
    || info "The installed $PLUGIN_ID predates openclaw filament login; updating it first."
  if [ "$INSTALL_SOURCE" = "git" ]; then
    info "Updating $PLUGIN_ID (installed from git) ..."
    # New plugin surfaces (a CLI command, skills) need consent again.
    openclaw plugins update "$PLUGIN_ID" --accept-capabilities || err "plugin update failed for $PLUGIN_ID."
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

if [ "$TOKEN_MODE" = 1 ] && [ -z "$TARGET_AGENT" ]; then
  # A token belongs to one Filament agent: it needs the OpenClaw agent to answer as it.
  case "$AGENT_IDS_CSV" in
    -) err "This gateway has no OpenClaw agent; set OPENCLAW_AGENT to create one." ;;
    *,*) err "This gateway has several OpenClaw agents ($AGENT_IDS_CSV); set OPENCLAW_AGENT to the one to connect." ;;
    *) TARGET_AGENT="$AGENT_IDS_CSV" ;;
  esac
fi
ACCOUNT_ID="$TARGET_AGENT"

if [ "$TOKEN_MODE" = 0 ]; then
  :
else
  if agent_known "$TARGET_AGENT"; then
    info "Using the existing OpenClaw agent '$TARGET_AGENT'."
  else
    info "Creating the OpenClaw agent '$TARGET_AGENT' ..."
    openclaw agents add "$TARGET_AGENT" \
      --workspace "$WORKSPACE_ROOT/$TARGET_AGENT" --non-interactive >/dev/null \
      || err "could not create the OpenClaw agent '$TARGET_AGENT'."
    OWNERSHIP="explicit"
  fi
fi

# --- 2b. Token + binding, in one validated config write --------------------------
# The token travels through the environment into the patch on stdin, never argv.
# Without a token only the shared settings below are written, if any are set.
BINDINGS_JSON="$(openclaw config get bindings --json 2>/dev/null || true)"
PLUGIN_CFG_JSON="$(openclaw config get "plugins.entries.${PLUGIN_ID}.config" --json 2>/dev/null || true)"
PATCH_AND_NOTES="$(python3 - "$BINDINGS_JSON" "$PLUGIN_CFG_JSON" "$ACCOUNT_ID" "$TARGET_AGENT" "$PLUGIN_ID" <<'PY'
import json, os, sys
raw_bindings, raw_cfg, account, agent, plugin_id = sys.argv[1:6]
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
if token:
    plugin_cfg["accounts"] = {account: {"connectToken": token}}
if mcp_url:
    plugin_cfg["mcpUrl"] = mcp_url
# Top level, so every account on this gateway, including the ones
# `openclaw filament login` adds later, uses the same transport and project.
transport = os.environ.get("TRANSPORT", "")
if transport:
    plugin_cfg["transport"] = transport
firebase = {
    key: os.environ[name].strip()
    for key, name in (
        ("projectId", "FILAMENT_FIREBASE_PROJECT_ID"),
        ("apiKey", "FILAMENT_FIREBASE_API_KEY"),
        ("appId", "FILAMENT_FIREBASE_APP_ID"),
        ("messagingSenderId", "FILAMENT_FIREBASE_SENDER_ID"),
    )
    if os.environ.get(name, "").strip()
}
if firebase:
    plugin_cfg["firebase"] = firebase

if not token and not plugin_cfg:
    print("")
    sys.exit(0)
patch = {"plugins": {"entries": {plugin_id: {"config": plugin_cfg}}}}
notes = []
if agent and token:
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

if [ "$TOKEN_MODE" = 1 ]; then
  info "Saving the connect token${TARGET_AGENT:+ and binding agent '$TARGET_AGENT' to Filament account '$ACCOUNT_ID'}${TRANSPORT:+ (transport: $TRANSPORT)} ..."
elif [ -n "$PATCH" ]; then
  info "Saving the Filament settings${TRANSPORT:+ (transport: $TRANSPORT)} ..."
fi
REPLACE_ARGS=()
[ "$TOKEN_MODE" = 1 ] && [ -n "$TARGET_AGENT" ] && REPLACE_ARGS=(--replace-path bindings)
if [ -n "$PATCH" ]; then
  # ${arr[@]+...}: bash 3.2 (macOS) treats an empty array as unset under set -u.
  printf '%s' "$PATCH" | openclaw config patch --stdin ${REPLACE_ARGS[@]+"${REPLACE_ARGS[@]}"} >/dev/null \
    || err "could not write the Filament account config (openclaw config patch failed)."
fi

if [ "$PLUGIN_ENABLED" != "1" ]; then
  info "Enabling $PLUGIN_ID ..."
  openclaw plugins enable "$PLUGIN_ID" --accept-capabilities \
    || err "could not enable $PLUGIN_ID."
fi

if [ "$TOKEN_MODE" = 0 ]; then
  info "$PLUGIN_ID is installed and enabled. Next, connect an agent by signing in to Filament:"
  printf '\n  openclaw filament login%s%s\n\n' \
    "${TARGET_AGENT:+ --agent $TARGET_AGENT}" "${FILAMENT_MCP_URL:+ --url $FILAMENT_MCP_URL}"
  info "It prints a link and a code; approve it in Filament and the agent connects."
  exit 0
fi

# --- 3. Verify this account connected -------------------------------------------
# Each account's log lines start with "[<account id>]".
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

if [ "$CONNECTED" = 1 ]; then
  info "Connected. OpenClaw agent '$TARGET_AGENT' is live on Filament.${PRINCIPAL:+ Principal: $PRINCIPAL.}"
  info "Say hi to it from the Filament app."
else
  warn "Config written, but account '$ACCOUNT_ID' did not report a connection within \
90s. Follow along with: openclaw logs --follow"
fi
