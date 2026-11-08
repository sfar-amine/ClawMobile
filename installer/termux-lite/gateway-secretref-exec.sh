#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
NODE="${CLAWMOBILE_GATEWAY_NODE:-$HOME/.openclaw-android/bin/node}"
DIST="${CLAWMOBILE_OPENCLAW_DIST:-/data/data/com.termux/files/usr/lib/node_modules/openclaw/dist}"
OC="${CLAWMOBILE_OPENCLAW_BIN:-/data/data/com.termux/files/usr/bin/openclaw}"
mkdir -p "$HOME/.cache/tmp"
export TMPDIR="$HOME/.cache/tmp"
# OpenClaw names this build chunk with a content hash that changes on every release: the 2026.10.9 update
# (S24 31/10) renamed gateway-auth-token-D8cKFnOh.mjs to gateway-auth-token-7OIpkk9l.mjs and this helper then
# failed silently (exit 1), breaking every MCP owner delegation. Resolve the one chunk of the installed build.
shopt -s nullglob
mods=("$DIST"/gateway-auth-token-*.mjs)
shopt -u nullglob
if [ "${#mods[@]}" -ne 1 ]; then
  echo "gateway_token_resolver_unavailable: ${#mods[@]} gateway-auth-token chunk(s) in the OpenClaw build" >&2
  exit 32
fi
MOD="${mods[0]}"
# Resolve through OpenClaw's native Gateway secret resolver. Keep the value only
# in this process environment; never echo it, write it to disk, or put it in argv.
v="$("$NODE" -e "(async()=>{const m=await import(process.argv[1]);let v='';await m.gatewayAuthTokenCommand({writeStdout:s=>v=s.trim()},{interactive:true});if(!v)process.exit(31);process.stdout.write(v)})()" "file://$MOD" 2>/dev/null)" || true
if [ -z "$v" ]; then
  echo "gateway_token_unavailable" >&2
  exit 31
fi
export OPENCLAW_GATEWAY_TOKEN="$v"
export OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
unset v
exec "$OC" "$@"
