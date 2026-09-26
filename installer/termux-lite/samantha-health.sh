#!/data/data/com.termux/files/usr/bin/bash
set -u
ok=0; bad=0; degraded=0
check(){ name="$1"; shift; if "$@" >/dev/null 2>&1; then printf '%-24s UP\n' "$name"; ok=$((ok+1)); else printf '%-24s DOWN\n' "$name"; bad=$((bad+1)); fi; }
printf '%-24s ' "ADB"
if adb devices 2>/dev/null | awk 'NR>1 && $2=="device"{found=1} END{exit !found}'; then echo UP; ok=$((ok+1)); else echo DEGRADED_OPTIONAL; degraded=$((degraded+1)); fi
check "Remote Desktop" pgrep -f '@wonderwhy-er/desktop-commander/dist/index.js remote'
check "Remote watchdog" pgrep -f 'remote-desktop-watchdog.sh'
check "ADB watchdog" pgrep -f 'adb-recovery-watchdog.sh'
check "OpenClaw Gateway" sh -c 'command -v curl >/dev/null && curl -fsS --max-time 3 http://127.0.0.1:18789/ >/dev/null'
check "Companion" sh -c 'command -v curl >/dev/null && curl -fsS --max-time 3 http://127.0.0.1:8765/v1/health >/dev/null'
printf '%-24s ' "WhatsApp"
ws="$(timeout 8 openclaw channels status 2>/dev/null || true)"
if printf '%s' "$ws" | grep -qi 'connected'; then echo UP; ok=$((ok+1)); else echo DEGRADED; bad=$((bad+1)); fi
printf '%-24s ' "Persistent boot"
if [ -x "$HOME/.termux/boot/start-samantha" ]; then echo READY; ok=$((ok+1)); else echo NOT_READY; bad=$((bad+1)); fi
printf '%-24s ' "Chat continuity"
if [ -s "$HOME/.openclaw/continuity/chatgpt-current.json" ]; then echo CHECKPOINTED; ok=$((ok+1)); else echo PENDING_ID; degraded=$((degraded+1)); fi
printf '\nSUMMARY ok=%d bad=%d degraded=%d\n' "$ok" "$bad" "$degraded"
[ "$bad" -eq 0 ]
