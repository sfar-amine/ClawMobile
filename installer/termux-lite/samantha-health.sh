#!/data/data/com.termux/files/usr/bin/bash
set -u
ok=0; bad=0
check(){ name="$1"; shift; if "$@" >/dev/null 2>&1; then printf '%-24s UP\n' "$name"; ok=$((ok+1)); else printf '%-24s DOWN\n' "$name"; bad=$((bad+1)); fi; }
check "ADB" adb -s 127.0.0.1:5556 get-state
check "Remote Desktop" pgrep -f '@wonderwhy-er/desktop-commander/dist/index.js remote'
check "Remote watchdog" pgrep -f 'remote-desktop-watchdog.sh'
check "OpenClaw Gateway" pgrep -f 'openclaw-gateway'
check "Companion" pgrep -f 'dist/companion/server.js'
printf '%-24s ' "WhatsApp"
ws="$(openclaw channels status 2>/dev/null || true)"
if printf '%s' "$ws" | grep -qi 'connected'; then echo UP; ok=$((ok+1)); else echo DEGRADED; bad=$((bad+1)); fi
printf '%-24s ' "Persisted bootstrap"
if termux-job-scheduler --pending >$HOME/.openclaw/health/jobs.$$ 2>/dev/null; then echo READY; ok=$((ok+1)); else echo NOT_READY; bad=$((bad+1)); fi
rm -f $HOME/.openclaw/health/jobs.$$
printf '\nSUMMARY ok=%d bad=%d\n' "$ok" "$bad"
[ "$bad" -eq 0 ]
