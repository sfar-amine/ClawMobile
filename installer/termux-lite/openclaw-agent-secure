#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
NODE="$HOME/.openclaw-android/bin/node"
MOD="/data/data/com.termux/files/usr/lib/node_modules/openclaw/dist/gateway-auth-token-D8cKFnOh.mjs"
OC="/data/data/com.termux/files/usr/bin/openclaw"
mkdir -p "$HOME/.cache/tmp"
export TMPDIR="$HOME/.cache/tmp"
# Resolve through OpenClaw's native Gateway secret resolver. Keep the value only
# in this process environment; never echo it, write it to disk, or put it in argv.
v="$("$NODE" -e "(async()=>{const m=await import('file://$MOD');let v='';await m.gatewayAuthTokenCommand({writeStdout:s=>v=s.trim()},{interactive:true});if(!v)process.exit(31);process.stdout.write(v)})()" 2>/dev/null)"
test -n "$v"
export OPENCLAW_GATEWAY_TOKEN="$v"
export OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
unset v
exec "$OC" agent exec "$@"
