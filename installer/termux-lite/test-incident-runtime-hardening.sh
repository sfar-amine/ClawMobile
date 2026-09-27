#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
bash -n "$R/incident-orchestrator-worker.sh" "$R/adb-recovery-watchdog.sh" "$R/samantha-health-manager.sh" "$R/samantha-root-guardian.sh"
! grep -q 'incident-notify.sh.*human_required' "$R/adb-recovery-watchdog.sh"
! grep -q 'incident-notify.sh.*human_required' "$R/samantha-health-manager.sh"
! grep -q 'incident-notify.sh.*human_required' "$R/boot-continuity-recovery.sh"
grep -q 'count.*-ge 2' "$R/incident-orchestrator-worker.sh"
grep -q 'human-boundary' "$R/incident-orchestrator-worker.sh"
grep -q 'grace_s=\$grace' "$R/samantha-health-manager.sh"
grep -q 'gateway.*120 45' "$R/samantha-health-manager.sh"
grep -q 'kill_stale' "$R/samantha-health-manager.sh"
grep -q 'sleep.*9>&-' "$R/samantha-health-manager.sh"
echo 'incident runtime hardening: OK'
