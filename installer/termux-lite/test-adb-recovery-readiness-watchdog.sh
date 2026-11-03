#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
. "$R/host_test_support.sh"  # shebangs Termux des doubles adaptés hors Termux (CI, conteneurs)
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
H="$T/home"
mkdir -p "$H/.openclaw/watchdogs" "$H/.openclaw/health" "$H/.openclaw/releases/current/termux-lite" "$T/bin"
# Explicit model-port fixture for these already-selected readiness actions.
cat >"$H/.openclaw/releases/current/termux-lite/immune-action.sh" <<'AI_FIXTURE'
immune_action(){ shift 2; "$@"; }
immune_observe(){ :; }
AI_FIXTURE
printf up >"$H/.openclaw/watchdogs/adb-recovery.state"
printf SERIAL1 >"$H/.openclaw/watchdogs/adb-expected-serial"

cat >"$T/bin/adb" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
printf '%s\n' "\$*" >>"$T/adb-calls"
case "\$*" in
 *"get-state"*) echo device;;
 *"getprop ro.serialno"*) echo SERIAL1;;
 *"settings put global adb_wifi_enabled 1"*) touch "$T/armed"; exit 0;;
 *) exit 0;;
esac
EOF
chmod +x "$T/bin/adb"

cat >"$H/.openclaw/releases/current/termux-lite/incident-orchestrator.py" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
printf '%s\n' "\$*" >>"$T/orchestrator"
[ "\${1:-}" = open ] && echo '{"id":"inc-readiness"}'
exit 0
EOF
chmod +x "$H/.openclaw/releases/current/termux-lite/incident-orchestrator.py"
cat >"$H/.openclaw/releases/current/termux-lite/incident-notify.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
printf '%s\n' "\$*" >>"$T/notifications"
EOF
chmod +x "$H/.openclaw/releases/current/termux-lite/incident-notify.sh"

cat >"$H/.openclaw/releases/current/termux-lite/incident-close.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
printf '%s\n' "\$*" >>"$T/closings"
EOF
chmod +x "$H/.openclaw/releases/current/termux-lite/incident-close.sh"

for x in capability-recovered.py adb-discover-endpoint.py; do
 cat >"$H/.openclaw/releases/current/termux-lite/$x" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
exit 0
EOF
 chmod +x "$H/.openclaw/releases/current/termux-lite/$x"
done

cat >"$H/fake-readiness-standby" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
if [ -e "$T/armed" ]; then
  echo '{"state":"ready","reason":"trusted_wireless_endpoint_verified","requires_owner_action":false}'
else
  echo '{"state":"standby","reason":"wireless_debugging_disabled_primary_healthy","requires_owner_action":false}'
fi
EOF
chmod +x "$H/fake-readiness-standby"
host_adapt_shebangs "$T"
PATH="$T/bin:$PATH" \
ADB_RECOVERY_HOME="$H" \
CLAW_RUNTIME_ROOT="$H/.openclaw/releases/current/termux-lite" \
ADB_RECOVERY_READINESS_HELPER="$H/fake-readiness-standby" \
ADB_RECOVERY_INTERVAL=0 \
ADB_RECOVERY_READINESS_HELP_AFTER=2 \
ADB_RECOVERY_MAX_LOOPS=1 \
bash "$R/adb-recovery-watchdog.sh"

test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.state")" = ready
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.failures")" = 0
! grep -q 'shell svc wifi enable' "$T/adb-calls"
grep -q 'settings put global adb_wifi_enabled 1' "$T/adb-calls"
test ! -e "$T/notifications"
grep -q 'event=readiness result=armed' "$H/.openclaw/watchdogs/adb-recovery.log"
test ! -e "$H/.openclaw/watchdogs/adb-recovery-readiness-arm.last"

# Cooldown prevents repeated enable churn when Android has not exposed the
# trusted endpoint yet.
rm -f "$T/armed" "$T/adb-calls"
date +%s >"$H/.openclaw/watchdogs/adb-recovery-readiness-arm.last"
printf standby >"$H/.openclaw/watchdogs/adb-recovery-readiness.state"
host_adapt_shebangs "$T"
PATH="$T/bin:$PATH" \
ADB_RECOVERY_HOME="$H" \
CLAW_RUNTIME_ROOT="$H/.openclaw/releases/current/termux-lite" \
ADB_RECOVERY_READINESS_HELPER="$H/fake-readiness-standby" \
ADB_RECOVERY_READINESS_ARM_INTERVAL=900 \
ADB_RECOVERY_INTERVAL=0 \
ADB_RECOVERY_MAX_LOOPS=1 \
bash "$R/adb-recovery-watchdog.sh"
! grep -q 'settings put global adb_wifi_enabled 1' "$T/adb-calls"
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.state")" = standby

rm -f "$T/notifications" "$T/orchestrator" "$T/closings"
printf ready >"$H/.openclaw/watchdogs/adb-recovery-readiness.state"
printf 9 >"$H/.openclaw/watchdogs/adb-recovery-readiness.failures"
printf up >"$H/.openclaw/watchdogs/adb-recovery.state"
cat >"$H/fake-readiness-advisory" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
echo '{"state":"degraded","reason":"wireless_endpoint_not_discoverable","requires_owner_action":true}'
EOF
chmod +x "$H/fake-readiness-advisory"
host_adapt_shebangs "$T"
PATH="$T/bin:$PATH" \
ADB_RECOVERY_HOME="$H" \
CLAW_RUNTIME_ROOT="$H/.openclaw/releases/current/termux-lite" \
ADB_RECOVERY_READINESS_HELPER="$H/fake-readiness-advisory" \
ADB_RECOVERY_INTERVAL=0 \
ADB_RECOVERY_READINESS_HELP_AFTER=2 \
ADB_RECOVERY_MAX_LOOPS=3 \
bash "$R/adb-recovery-watchdog.sh"
test ! -e "$T/notifications"
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.state")" = standby
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.failures")" = 0
grep -q 'recover device.adb.recovery_readiness runtime' "$T/orchestrator"
! grep -q 'human_required' "$T/orchestrator"

# A historical readiness human-required marker is superseded silently when
# primary ADB is healthy and recovery readiness is only standby.
rm -f "$T/orchestrator" "$T/closings"
printf inc-readiness >"$H/.openclaw/watchdogs/adb-recovery-readiness-notified"
printf degraded >"$H/.openclaw/watchdogs/adb-recovery-readiness.state"
host_adapt_shebangs "$T"
PATH="$T/bin:$PATH" \
ADB_RECOVERY_HOME="$H" \
CLAW_RUNTIME_ROOT="$H/.openclaw/releases/current/termux-lite" \
ADB_RECOVERY_READINESS_HELPER="$H/fake-readiness-standby" \
ADB_RECOVERY_INTERVAL=0 \
ADB_RECOVERY_MAX_LOOPS=1 \
bash "$R/adb-recovery-watchdog.sh"
grep -q 'recover device.adb.recovery_readiness runtime' "$T/orchestrator"
test ! -e "$H/.openclaw/watchdogs/adb-recovery-readiness-notified"
test ! -e "$T/closings"

# A historical human-required readiness incident still closes once real readiness returns.
printf inc-readiness >"$H/.openclaw/watchdogs/adb-recovery-readiness-notified"
cat >"$H/fake-readiness-ready" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
echo '{"state":"ready","reason":"trusted_wireless_endpoint_verified","requires_owner_action":false}'
EOF
chmod +x "$H/fake-readiness-ready"
host_adapt_shebangs "$T"
PATH="$T/bin:$PATH" \
ADB_RECOVERY_HOME="$H" \
CLAW_RUNTIME_ROOT="$H/.openclaw/releases/current/termux-lite" \
ADB_RECOVERY_READINESS_HELPER="$H/fake-readiness-ready" \
ADB_RECOVERY_INTERVAL=0 \
ADB_RECOVERY_MAX_LOOPS=1 \
bash "$R/adb-recovery-watchdog.sh"

grep -q 'recover device.adb.recovery_readiness runtime' "$T/orchestrator"
grep -q 'ADB recovery readiness' "$T/closings"
test ! -e "$H/.openclaw/watchdogs/adb-recovery-readiness-notified"
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.state")" = ready
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.failures")" = 0

# S24 26/10 (a3e972e2): Wi-Fi off gives standby/wifi_disabled_recovery_standby. Nothing can be
# armed, so the watchdog never asks the immune gate (no model call, no incident).
cat >"$H/.openclaw/releases/current/termux-lite/immune-action.sh" <<AI_FIXTURE
immune_action(){ printf '%s\n' "\$1 \$2" >>"$T/immune-calls"; shift 2; "\$@"; }
immune_observe(){ :; }
AI_FIXTURE
cat >"$H/fake-readiness-wifi-off" <<'WIFI_OFF'
#!/data/data/com.termux/files/usr/bin/bash
echo '{"state":"standby","reason":"wifi_disabled_recovery_standby","requires_owner_action":false}'
WIFI_OFF
chmod +x "$H/fake-readiness-wifi-off"
rm -f "$T/armed" "$T/adb-calls" "$T/immune-calls" "$H/.openclaw/watchdogs/adb-recovery-readiness-arm.last"
printf ready >"$H/.openclaw/watchdogs/adb-recovery-readiness.state"
host_adapt_shebangs "$T"
PATH="$T/bin:$PATH" \
ADB_RECOVERY_HOME="$H" \
CLAW_RUNTIME_ROOT="$H/.openclaw/releases/current/termux-lite" \
ADB_RECOVERY_READINESS_HELPER="$H/fake-readiness-wifi-off" \
ADB_RECOVERY_INTERVAL=0 \
ADB_RECOVERY_MAX_LOOPS=1 \
bash "$R/adb-recovery-watchdog.sh"
# `! grep` never fails under set -e: assert explicitly.
if grep -q 'device.adb.recovery_readiness' "$T/immune-calls" 2>/dev/null; then echo 'immune gate asked with Wi-Fi off' >&2; exit 1; fi
if grep -q 'settings put global adb_wifi_enabled 1' "$T/adb-calls" 2>/dev/null; then echo 'arm attempted with Wi-Fi off' >&2; exit 1; fi
test "$(cat "$H/.openclaw/watchdogs/adb-recovery-readiness.state")" = standby

# A disabled Wireless Debugging (Wi-Fi on) still goes through the immune gate.
rm -f "$T/immune-calls"
PATH="$T/bin:$PATH" \
ADB_RECOVERY_HOME="$H" \
CLAW_RUNTIME_ROOT="$H/.openclaw/releases/current/termux-lite" \
ADB_RECOVERY_READINESS_HELPER="$H/fake-readiness-standby" \
ADB_RECOVERY_INTERVAL=0 \
ADB_RECOVERY_MAX_LOOPS=1 \
bash "$R/adb-recovery-watchdog.sh"
grep -q 'device.adb.recovery_readiness bounded-wireless-readiness-arm' "$T/immune-calls"
echo 'adb recovery readiness closed loop: OK'
