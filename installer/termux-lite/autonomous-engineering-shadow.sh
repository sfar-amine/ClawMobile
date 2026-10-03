#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

ROOT="${CLAW_RUNTIME_ROOT:-$HOME/ClawMobile/installer/termux-lite}"
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
flock -n 9 || exit 75

incident_id="${canonical_incident_id:-health-$component-$(date +%s)}"
output="$SHADOW/$incident_id.json"
evidence="$SHADOW/$incident_id.evidence.json"
errfile="$SHADOW/$incident_id.stderr"
python3 - "$HEALTH_LOG" "$component" "$failures" "$evidence" "$ROOT" "$incident_id" <<'PY'
import datetime, json, pathlib, sys, importlib.util, sqlite3
log_path, component, failures, out, runtime_root, incident_id = sys.argv[1:]
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
if component == "remote_desktop":
    spec=importlib.util.spec_from_file_location("rdc_control",pathlib.Path(runtime_root)/"remote-desktop-control.py")
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    payload.update(module.diagnostics())
    payload["source"]="remote-desktop-watchdog"
    payload["incident_id"]=incident_id
    payload["shadow_mode"]=False
    payload["execution_boundary"]="Model selects catalog action only; controller executes fixed repair and verifies it. No code editing."
    db=pathlib.Path.home()/".openclaw/incidents/orchestrator.db"
    with sqlite3.connect(f"file:{db}?mode=ro",uri=True) as conn:
        row=conn.execute("select state from incidents where id=?",(incident_id,)).fetchone()
        payload["incident_state"]=row[0] if row else "missing"
        rows=conn.execute("select seq,kind,payload from events where incident_id=? and kind in ('diagnosis','diagnostics_collected') order by seq desc limit 4",(incident_id,)).fetchall()
        payload["previous_rounds"]=[{"seq":seq,"kind":kind,"payload":json.loads(value)} for seq,kind,value in reversed(rows)]
pathlib.Path(out).write_text(json.dumps(payload, ensure_ascii=False))
PY

tmp="$output.tmp"
cd "$UI"
# RDC requires one bounded follow-up OR availability fallback; same incident budget.
max_calls=1
[ "$component" = remote_desktop ] && max_calls=2
set +e
PYTHONPATH=. timeout 120 python -m skill_intelligence.cli diagnose   persistent_health_failure   --target "$component"   --incident-id "$incident_id"   --evidence-file "$evidence"   --max-calls "$max_calls" >"$tmp" 2>"$errfile"
rc=$?
set -e
if [ "$rc" -eq 0 ] && python3 -m json.tool "$tmp" >/dev/null 2>&1; then
  mv "$tmp" "$output"
  # Preserve each round's exact bounded dossier/result for continuation and attribution.
  if [ "$component" = remote_desktop ]; then
    round=$(python3 - "$output" <<'PY_ROUND'
import json,sys
r=json.load(open(sys.argv[1]));print(int((r.get('governor') or {}).get('total_calls',0)))
PY_ROUND
)
    cp "$output" "$SHADOW/$incident_id.round-$round.json"
    mv "$evidence" "$SHADOW/$incident_id.round-$round.evidence.json"
  else
    rm -f "$evidence"
  fi
  rm -f "$errfile"
  printf '%s component=%s incident=%s state=diagnosed_shadow\n'     "$(date -Iseconds)" "$component" "$incident_id"     >>"$BASE/shadow.log"
  if [ -n "$canonical_incident_id" ]; then
    # A late model answer is evidence only after an incident closes.
    active=$(python3 - "$ROOT/incident-orchestrator.py" "$incident_id" <<'PY_STATE'
import importlib.util,sys
spec=importlib.util.spec_from_file_location('orch',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
r=m.show(sys.argv[2]).get('incident') or {};print(r.get('state','missing'))
PY_STATE
)
    case "$active" in recovered|failed|human_required|missing) exit 0;; esac
    action=$(python3 - "$output" <<'PY2'
import json,sys
try:
 d=json.load(open(sys.argv[1])); valid=d.get('status')=='success' and d.get('model_verified') is True
 print(((d.get("diagnosis") or {}).get("recommended_action_id") or "") if valid else "")
except Exception: print("")
PY2
)
    "$ROOT/incident-orchestrator.py" observe "$incident_id" diagnosis --source autonomous-engineering --json "$(python3 - "$output" <<'PY_RESULT'
import json,sys
r=json.load(open(sys.argv[1]));print(json.dumps({k:r.get(k) for k in ['status','model','actual_model','model_verified','error_kind']} | {'recommended_action_id':(r.get('diagnosis') or {}).get('recommended_action_id') if r.get('status')=='success' and r.get('model_verified') is True else None}))
PY_RESULT
)" >/dev/null 2>&1 || true
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
