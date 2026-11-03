#!/data/data/com.termux/files/usr/bin/bash
# Codex app-server launcher for Android/Termux (OPENCLAW_CODEX_APP_SERVER_BIN, exported by gateway-start.sh).
#
# The managed Codex binary of @openclaw/codex is a static musl build: it resolves DNS only through
# /etc/resolv.conf, which Android does not have, so every model call fails with "workspace routing discovery
# failed" and the hosted web search never answers. proot binds Termux's resolv.conf at /etc/resolv.conf for this
# process only; SSL_CERT_FILE points at Termux's CA bundle. Arguments are passed through unchanged.
set -u
STATE="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
real="${CODEX_TERMUX_REAL:-}"
if [ -z "$real" ]; then
  shopt -s nullglob
  candidates=("$STATE"/npm/projects/*/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex)
  shopt -u nullglob
  if [ "${#candidates[@]}" -ne 1 ]; then
    echo "codex-termux: expected exactly one managed Codex binary, found ${#candidates[@]}" >&2
    exit 127
  fi
  real="${candidates[0]}"
fi
[ -x "$real" ] || { echo "codex-termux: Codex binary not executable: $real" >&2; exit 127; }
if [ -z "${SSL_CERT_FILE:-}" ] && [ -f "$PREFIX/etc/tls/cert.pem" ]; then
  export SSL_CERT_FILE="$PREFIX/etc/tls/cert.pem"
fi
if [ -e /etc/resolv.conf ] || ! command -v proot >/dev/null 2>&1 || [ ! -f "$PREFIX/etc/resolv.conf" ]; then
  exec "$real" "$@"
fi
exec proot -b "$PREFIX/etc/resolv.conf:/etc/resolv.conf" "$real" "$@"
