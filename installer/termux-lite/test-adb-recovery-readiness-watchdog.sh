#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
H="$T/home"
mkdir -p "$H/.openclaw/watchdogs" "$H/.openclaw/health" "$H/ClawMobile/installer/termux-lite" "$T/bin"
printf up >"$H/.openclaw/watchdogs/adb-recovery.state"
printf SERIAL1 >"$H/.openclaw/watchdogs/adb-expected-serial"

cat >"$T/bin/adb" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
case "$*" in
 *"get-state"*) echo device;;
 *"getprop ro.serialno"*) echo SERIAL1;;
 *) exit 0;;
esac
EOF
chmod +x "$T/bin/adb"

cat >"$H/fake-readiness" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
C="$T/count"
n=\$(cat "\$C" 2>/dev/null || echo 0); n=\$((n+1)); echo "\$n" >"\$C"
if [ "\$n" -le 3 ]; then
  echo '{"state":"degraded","reason":"wireless_debugging_disabled","requires_owner_action":true}'
else
  echo '{"state":"ready","reason":"trusted_wireless_endpoint_verified"}'
fi
EOF
chmod +x "$H/fake-readiness"

cat >"$H/ClawMobile/installer/termux-lite/incident-notify.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
printf '%s|%s\n' "\$1" "\$2" >>"$T/notifications"
EOF
chmod +x "$H/ClawMobile/installer/termux-lite/incident-notify.sh"

for x in capability-recovered.py chat-continuity-restore.sh incident-orchestrator.py adb-discover-endpoint.py; do
 cat >"$H/ClawMobile/installer/termux-lite/$x" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
exit 0
EOF
 chmod +x "$H/ClawMobile/installer/termux-lite/$x"
done

PATH="$T/bin:$PATH" \
ADB_RECOVERY_HOME="$H" \
ADB_RECOVERY_READINESS_HELPER="$H/fake-readiness" \
ADB_RECOVERY_INTERVAL=0 \
ADB_RECOVERY_READINESS_HELP_AFTER=3 \
ADB_RECOVERY_MAX_LOOPS=5 \
"$R/adb-recovery-watchdog.sh"

test "$(wc -l <"$T/notifications")" -eq 2
grep -q 'capacité de reprise automatique est dégradée' "$T/notifications"
grep -q 'capacité de reprise ADB rétablie' "$T/notifications"
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.state")" = ready
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.failures")" = 0
test ! -e "$H/.openclaw/watchdogs/adb-recovery-readiness-notified"
echo 'adb recovery readiness watchdog: OK'

# A non-actionable degraded readiness (for example Wi-Fi intentionally off)
# must remain visible without spamming owner notifications.
rm -f "$T/notifications" "$H/.openclaw/watchdogs/adb-recovery-readiness-notified"
printf up >"$H/.openclaw/watchdogs/adb-recovery.state"
cat >"$H/fake-readiness-standby" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
echo '{"state":"degraded","reason":"wifi_disabled_recovery_standby","requires_owner_action":false}'
EOF
chmod +x "$H/fake-readiness-standby"
PATH="$T/bin:$PATH" \
ADB_RECOVERY_HOME="$H" \
ADB_RECOVERY_READINESS_HELPER="$H/fake-readiness-standby" \
ADB_RECOVERY_INTERVAL=0 \
ADB_RECOVERY_READINESS_HELP_AFTER=2 \
ADB_RECOVERY_MAX_LOOPS=3 \
"$R/adb-recovery-watchdog.sh"
test ! -e "$T/notifications"
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.failures")" = 0
test ! -e "$H/.openclaw/watchdogs/adb-recovery-readiness-notified"
echo 'adb recovery readiness standby notification: OK'
