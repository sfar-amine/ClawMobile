#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
H="$T/home"
mkdir -p "$H/.openclaw/watchdogs" "$H/.openclaw/health" "$H/ClawMobile/installer/termux-lite" "$T/bin"
printf up >"$H/.openclaw/watchdogs/adb-recovery.state"
printf SERIAL1 >"$H/.openclaw/watchdogs/adb-expected-serial"

cat >"$T/bin/adb" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
printf '%s\n' "\$*" >>"$T/adb-calls"
case "\$*" in
 *"get-state"*) echo device;;
 *"getprop ro.serialno"*) echo SERIAL1;;
 *) exit 0;;
esac
EOF
chmod +x "$T/bin/adb"

cat >"$H/ClawMobile/installer/termux-lite/incident-orchestrator.py" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
printf '%s\n' "\$*" >>"$T/orchestrator"
[ "\${1:-}" = open ] && echo '{"id":"inc-readiness"}'
exit 0
EOF
chmod +x "$H/ClawMobile/installer/termux-lite/incident-orchestrator.py"
cat >"$H/ClawMobile/installer/termux-lite/incident-notify.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
printf '%s\n' "\$*" >>"$T/notifications"
EOF
chmod +x "$H/ClawMobile/installer/termux-lite/incident-notify.sh"

cat >"$H/ClawMobile/installer/termux-lite/incident-close.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
printf '%s\n' "\$*" >>"$T/closings"
EOF
chmod +x "$H/ClawMobile/installer/termux-lite/incident-close.sh"

for x in capability-recovered.py chat-continuity-restore.sh adb-discover-endpoint.py; do
 cat >"$H/ClawMobile/installer/termux-lite/$x" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
exit 0
EOF
 chmod +x "$H/ClawMobile/installer/termux-lite/$x"
done

cat >"$H/fake-readiness-auto" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
C="$T/auto-count"
n=\$(cat "\$C" 2>/dev/null || echo 0); n=\$((n+1)); echo "\$n" >"\$C"
if [ "\$n" -eq 1 ]; then
 echo '{"state":"degraded","reason":"wifi_disabled_recovery_standby","requires_owner_action":true}'
else
 echo '{"state":"ready","reason":"trusted_wireless_endpoint_verified","requires_owner_action":false}'
fi
EOF
chmod +x "$H/fake-readiness-auto"
PATH="$T/bin:$PATH" \
ADB_RECOVERY_HOME="$H" \
ADB_RECOVERY_READINESS_HELPER="$H/fake-readiness-auto" \
ADB_RECOVERY_INTERVAL=0 \
ADB_RECOVERY_READINESS_HELP_AFTER=2 \
ADB_RECOVERY_MAX_LOOPS=1 \
"$R/adb-recovery-watchdog.sh"

grep -q 'shell svc wifi enable' "$T/adb-calls"
grep -q 'settings put global adb_wifi_enabled 1' "$T/adb-calls"
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.state")" = ready
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.failures")" = 0
test ! -e "$T/notifications"

rm -f "$T/notifications" "$T/orchestrator" "$T/closings"
: >"$H/.openclaw/watchdogs/adb-recovery-readiness-notified"
printf up >"$H/.openclaw/watchdogs/adb-recovery.state"
cat >"$H/fake-readiness-advisory" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
echo '{"state":"degraded","reason":"wireless_endpoint_not_discoverable","requires_owner_action":true}'
EOF
chmod +x "$H/fake-readiness-advisory"
PATH="$T/bin:$PATH" \
ADB_RECOVERY_HOME="$H" \
ADB_RECOVERY_READINESS_HELPER="$H/fake-readiness-advisory" \
ADB_RECOVERY_INTERVAL=0 \
ADB_RECOVERY_READINESS_HELP_AFTER=2 \
ADB_RECOVERY_MAX_LOOPS=3 \
"$R/adb-recovery-watchdog.sh"
test ! -e "$T/notifications"
test ! -e "$T/orchestrator"
test ! -s "$H/.openclaw/watchdogs/adb-recovery-readiness-notified"
grep -q 'event=readiness result=advisory' "$H/.openclaw/watchdogs/adb-recovery.log"

# A historical human-required readiness incident still closes once real readiness returns.
printf inc-readiness >"$H/.openclaw/watchdogs/adb-recovery-readiness-notified"
cat >"$H/fake-readiness-ready" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
echo '{"state":"ready","reason":"trusted_wireless_endpoint_verified","requires_owner_action":false}'
EOF
chmod +x "$H/fake-readiness-ready"
PATH="$T/bin:$PATH" \
ADB_RECOVERY_HOME="$H" \
ADB_RECOVERY_READINESS_HELPER="$H/fake-readiness-ready" \
ADB_RECOVERY_INTERVAL=0 \
ADB_RECOVERY_MAX_LOOPS=1 \
"$R/adb-recovery-watchdog.sh"

grep -q 'recover device.adb.recovery_readiness runtime' "$T/orchestrator"
grep -q 'ADB recovery readiness' "$T/closings"
test ! -e "$H/.openclaw/watchdogs/adb-recovery-readiness-notified"
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.state")" = ready
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.failures")" = 0
echo 'adb recovery readiness closed loop: OK'
