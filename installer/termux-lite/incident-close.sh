#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="${CLAW_RUNTIME_ROOT:-$HOME/ClawMobile/installer/termux-lite}"
D="$HOME/.openclaw/incidents"; Q="$D/queue"; LOG="$D/events.log"
component="${1:-}"; message="${2:-Samantha — récupération vérifiée.}"
learning_file="${CLAW_LEARNING_FILE:-}"
[ -n "$component" ] || exit 64
run_learning_gate(){
  local incident_id="$1" summary="$2" final_fix="$3" gate_json
  local args=(--source legacy_incident --closure-id "$incident_id" --component "$component" --status recovered --summary "$summary" --final-fix "$final_fix")
  [ -z "$learning_file" ] || args+=(--learning-file "$learning_file")
  gate_json="$("$ROOT/learning-gate-close.sh" "${args[@]}" 2>/dev/null)" || return 1
  [ -n "$gate_json" ]
}
matched=0
last_id=""
for dir in "$Q"/*; do
  [ -d "$dir" ] || continue
  st="$(cat "$dir/status" 2>/dev/null || echo pending)"
  [ "$st" = closed ] && continue
  msg="$(cat "$dir/message" 2>/dev/null || true)"
  kind="$(cat "$dir/kind" 2>/dev/null || true)"
  # Prefer the structured incident identity. Legacy queue entries did not have
  # one, so retain an exact token match without the old substring ambiguity
  # (for example, `adb` must never close `adb_watchdog`).
  stored="$(cat "$dir/component" 2>/dev/null || true)"
  if [ -n "$stored" ]; then
    [ "$stored" = "$component" ] || continue
  elif [ "$kind" != "$component" ]; then
    python3 - "$component" "$msg" <<'PY' >/dev/null 2>&1 || continue
import re,sys
component,message=sys.argv[1:]
raise SystemExit(0 if re.search(r'(?<![A-Za-z0-9_])'+re.escape(component)+r'(?![A-Za-z0-9_])',message,re.I) else 1)
PY
  fi
  id="$(basename "$dir")"; matched=1; last_id="$id"
  printf recovered >"$dir/status"
  printf '%s id=%s component=%s event=recovered state=verified\n' "$(date -Iseconds)" "$id" "$component" >>"$LOG"
  run_learning_gate "$id" "$msg" "$message" || continue
  printf closed >"$dir/status"
  printf '%s' "$(date -Iseconds)" >"$dir/closed"
  printf '%s id=%s component=%s event=closed state=ok\n' "$(date -Iseconds)" "$id" "$component" >>"$LOG"
done
if [ "$matched" -eq 1 ]; then
  recovery_key="recovery-$(printf '%s' "$component:$last_id" | sha256sum | cut -c1-24)"
  if timeout 18 "$ROOT/whatsapp-owner-send.sh" "$message" "$recovery_key" >/dev/null 2>&1; then
    printf '%s component=%s recovery_channel=whatsapp state=accepted\n' "$(date -Iseconds)" "$component" >>"$LOG"
  elif timeout 35 "$ROOT/incident-email.sh" "Samantha: récupération vérifiée" "$message"; then
    printf '%s component=%s recovery_channel=email state=accepted\n' "$(date -Iseconds)" "$component" >>"$LOG"
  else
    printf '%s component=%s recovery_channel=none state=failed\n' "$(date -Iseconds)" "$component" >>"$LOG"
  fi
fi
