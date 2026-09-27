#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

ROOT="$HOME/ClawMobile/installer/termux-lite"
UI="$HOME/.openclaw/workspace/ui-playbooks"
BASE="$HOME/.openclaw/autonomous-engineering"
SHADOW="$BASE/shadow"
LOCKS="$BASE/locks"
HEALTH_LOG="$HOME/.openclaw/health/health.log"
component="${1:-}"
failures="${2:-0}"
canonical_incident_id="${3:-}"

case "$component" in
  ""|*[!A-Za-z0-9._-]*) exit 64 ;;
esac
case "$failures" in
  *[!0-9]*|"") exit 64 ;;
esac

mkdir -p "$SHADOW" "$LOCKS"
chmod 700 "$BASE" "$SHADOW" "$LOCKS" 2>/dev/null || true
exec 9>"$LOCKS/$component.lock"
flock -n 9 || exit 0

incident_id="${canonical_incident_id:-health-$component-$(date +%s)}"
output="$SHADOW/$incident_id.json"
evidence="$SHADOW/$incident_id.evidence.json"
errfile="$SHADOW/$incident_id.stderr"
python3 - "$HEALTH_LOG" "$component" "$failures" "$evidence" <<'PY'
import datetime, json, pathlib, sys
log_path, component, failures, out = sys.argv[1:]
recent = []
p = pathlib.Path(log_path)
if p.exists():
    marker = f"service={component}"
    for line in p.read_text(errors="replace").splitlines()[-250:]:
        if marker in line:
            recent.append(line[:500])
recent = recent[-12:]
payload = {
    "source": "samantha-health-manager",
    "component": component,
    "failures": int(failures),
    "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "recent_health_events": recent,
    "shadow_mode": True,
}
pathlib.Path(out).write_text(json.dumps(payload, ensure_ascii=False))
PY

tmp="$output.tmp"
cd "$UI"
set +e
PYTHONPATH=. timeout 120 python -m skill_intelligence.cli diagnose   persistent_health_failure   --target "$component"   --incident-id "$incident_id"   --evidence-file "$evidence"   --max-calls 1 >"$tmp" 2>"$errfile"
rc=$?
set -e
if [ "$rc" -eq 0 ] && python3 -m json.tool "$tmp" >/dev/null 2>&1; then
  mv "$tmp" "$output"
  rm -f "$evidence" "$errfile"
  printf '%s component=%s incident=%s state=diagnosed_shadow\n'     "$(date -Iseconds)" "$component" "$incident_id"     >>"$BASE/shadow.log"
  if [ -n "$canonical_incident_id" ]; then
    action=$(python3 - "$output" <<'PY2'
import json,sys
try: print(((json.load(open(sys.argv[1])).get("diagnosis") or {}).get("recommended_action_id")) or "")
except Exception: print("")
PY2
)
    "$ROOT/incident-orchestrator.py" observe "$incident_id" diagnosis --source autonomous-engineering --json "{\"recommended_action_id\":\"$action\"}" >/dev/null 2>&1 || true
    if [ "$action" = diagnostics.collect_more ]; then
      "$ROOT/incident-orchestrator.py" transition "$incident_id" planning --source autonomous-engineering --reason "additional diagnostics required" >/dev/null 2>&1 || true
    fi
  fi
  exit 0
fi

rm -f "$tmp" "$evidence"
printf '{"status":"runner_error","incident_id":"%s","component":"%s","exit_code":%s}
'   "$incident_id" "$component" "$rc" >"$output"
rm -f "$errfile"
printf '%s component=%s incident=%s state=shadow_failed exit_code=%s
'   "$(date -Iseconds)" "$component" "$incident_id" "$rc"   >>"$BASE/shadow.log"
exit "$rc"
