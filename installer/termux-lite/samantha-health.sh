#!/data/data/com.termux/files/usr/bin/bash
set -u
ok=0; bad=0; degraded=0
check(){ name="$1"; shift; if "$@" >/dev/null 2>&1; then printf '%-24s UP\n' "$name"; ok=$((ok+1)); else printf '%-24s DOWN\n' "$name"; bad=$((bad+1)); fi; }
printf '%-24s ' "ADB canonical"
expected="$(cat "$HOME/.openclaw/watchdogs/adb-expected-serial" 2>/dev/null || true)"
actual="$(timeout 3 adb -s 127.0.0.1:5556 shell getprop ro.serialno 2>/dev/null | tr -d '\r\n' || true)"
if timeout 3 adb -s 127.0.0.1:5556 get-state 2>/dev/null | grep -qx device && { [ -z "$expected" ] || [ "$actual" = "$expected" ]; }; then echo UP; ok=$((ok+1)); else echo DEGRADED; degraded=$((degraded+1)); fi
check "Root Guardian" pgrep -f '[s]amantha-root-guardian.sh'
check "Health Manager" pgrep -f '[s]amantha-health-manager.sh'
check "Incident Manager" pgrep -f '[i]ncident-manager.sh'
check "Incident Orchestrator" pgrep -f '[i]ncident-orchestrator-worker.sh'
check "Remote Desktop" pgrep -f '@wonderwhy-er/desktop-commander/dist/index.js remote'
check "Remote watchdog" pgrep -f 'remote-desktop-watchdog.sh'
check "ADB watchdog" pgrep -f 'adb-recovery-watchdog.sh'
check "OpenClaw Gateway" sh -c 'command -v curl >/dev/null && curl -fsS --max-time 3 http://127.0.0.1:18789/healthz >/dev/null'
check "Companion" sh -c 'command -v curl >/dev/null && curl -fsS --max-time 3 http://127.0.0.1:8765/v1/health >/dev/null'
printf '%-24s ' "WhatsApp"
ws="$(timeout 8 openclaw channels status 2>/dev/null || true)"
last_wa="$(tail -n 1 "$HOME/.openclaw/health/whatsapp-outbound.log" 2>/dev/null || true)"
[ -n "$last_wa" ] || last_wa="$(grep 'channel=whatsapp state=' "$HOME/.openclaw/incidents/events.log" 2>/dev/null | tail -n 1 || true)"
if ! printf '%s' "$ws" | grep -qi 'connected'; then echo DOWN; bad=$((bad+1))
elif printf '%s' "$last_wa" | grep -q 'state=failed'; then echo DEGRADED_OUTBOUND; degraded=$((degraded+1))
else echo UP; ok=$((ok+1)); fi
printf '%-24s ' "Alert email fallback"
last_email="$(grep 'channel=email state=accepted' "$HOME/.openclaw/incidents/events.log" 2>/dev/null | tail -n 1 || true)"
if [ -n "$last_email" ]; then echo READY; ok=$((ok+1)); else echo UNVERIFIED; degraded=$((degraded+1)); fi
printf '%-24s ' "Persistent boot"
if [ -x "$HOME/.termux/boot/start-samantha" ]; then echo READY; ok=$((ok+1)); else echo NOT_READY; bad=$((bad+1)); fi
printf '%-24s ' "Chat continuity"
if [ -s "$HOME/.openclaw/continuity/chatgpt-current.json" ]; then echo CHECKPOINTED; ok=$((ok+1)); else echo PENDING_ID; degraded=$((degraded+1)); fi
printf '\nSUMMARY ok=%d bad=%d degraded=%d\n' "$ok" "$bad" "$degraded"
[ "$bad" -eq 0 ]
