#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home/.openclaw" "$T/bin"
cat >"$T/home/.openclaw/openclaw.json" <<'JSON'
{"commands":{"ownerAllowFrom":["whatsapp:+21611111111"]}}
JSON
cat >"$T/bin/openclaw" <<'SH'
#!/data/data/com.termux/files/usr/bin/bash
printf '%s\n' "$*" >"$HOME/call.args"
printf '%s\n' '{"runId":"test-key","messageId":"fake-message-id","channel":"whatsapp"}'
SH
chmod 700 "$T/bin/openclaw"
HOME="$T/home" PATH="$T/bin:$PATH" "$R/whatsapp-owner-send.sh" "private test body" "test-key" >"$T/out"
grep -qx 'fake-message-id' "$T/out"
grep -q 'gateway call send' "$T/home/call.args"
grep -q '"idempotencyKey": "test-key"' "$T/home/call.args"
grep -q 'state=accepted' "$T/home/.openclaw/health/whatsapp-outbound.log"
! grep -q '21611111111' "$T/home/.openclaw/health/whatsapp-outbound.log"
! grep -q 'private test body' "$T/home/.openclaw/health/whatsapp-outbound.log"
echo 'whatsapp owner send: OK'