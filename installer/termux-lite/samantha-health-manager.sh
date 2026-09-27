#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="$HOME/ClawMobile/installer/termux-lite"; D="$HOME/.openclaw/health"; LOG="$D/health.log"; S="$D/state"; mkdir -p "$D" "$S"; export TMPDIR="$HOME/.cache/tmp"
exec 9>"$D/health.lock"; flock -n 9 || exit 0
log(){ printf '%s component=health-manager %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
proc(){ pgrep -f "$1" >/dev/null 2>&1; }; http(){ timeout 3 curl -fsS "$1" >/dev/null 2>&1; }; adb_ok(){ timeout 3 adb -s 127.0.0.1:5556 get-state 2>/dev/null|grep -qx device; }
now(){ date +%s; }; sf(){ echo "$S/$1.$2"; }; get(){ cat "$(sf "$1" "$2")" 2>/dev/null || echo "${3:-0}"; }; put(){ printf '%s' "$3" >"$(sf "$1" "$2")"; }
healthy(){ n="$1"; prev=$(get "$n" status unknown); old=$(get "$n" failures 0); [ "$prev" = healthy ] || log "service=$n state=healthy"; put "$n" status healthy; put "$n" failures 0; put "$n" next 0; if [ "$prev" = degraded ] && [ "$old" -ge 3 ]; then "$ROOT/incident-close.sh" "$n" "Samantha — $n est de nouveau opérationnel et la récupération est vérifiée." || true; fi; }
scope(){ if [ "$1" = adb ]; then printf "boot-%s" "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)"; else printf runtime; fi; }
incident_open(){ "$ROOT/incident-orchestrator.py" open "$1" "$(scope "$1")" --source health-manager --summary "$1 persistent health failure" 2>/dev/null | python -c 'import sys,json; print(json.load(sys.stdin)["id"])'; }
shadow(){ n="$1"; c="$2"; iid="$3"; nohup "$ROOT/autonomous-engineering-shadow.sh" "$n" "$c" "$iid" 9>&- >>"$D/autonomous-engineering-shadow.stderr.log" 2>&1 </dev/null & }
fail(){ n="$1"; c=$(( $(get "$n" failures 0)+1 )); [ "$c" -gt 6 ] && c=6; delay=$((15*(1<<(c-1)))); [ "$delay" -gt 900 ] && delay=900; put "$n" failures "$c"; put "$n" status degraded; put "$n" next $(( $(now)+delay )); log "service=$n state=degraded failures=$c retry_in_s=$delay"; if [ "$c" -eq 3 ]; then iid=$(incident_open "$n"); log "service=$n action=autonomous_engineering_shadow incident_id=$iid"; "$ROOT/incident-orchestrator.py" transition "$iid" diagnosing --source health-manager --reason "deterministic recovery exhausted" >/dev/null 2>&1 || true; shadow "$n" "$c" "$iid"; fi; }
due(){ [ "$(now)" -ge "$(get "$1" next 0)" ]; }
start(){ nohup "$2" 9>&- >>"$D/$1.stderr.log" 2>&1 </dev/null & }
check_supervisor(){ n="$1"; pat="$2"; script="$3"; if proc "$pat"; then healthy "$n"; return; fi; due "$n" || return; log "service=$n action=start"; start "$n" "$script"; sleep 3 9>&-; proc "$pat" && healthy "$n" || fail "$n"; }
check_http(){ n="$1"; url="$2"; pat="$3"; script="$4"; grace="${5:-10}"; stop_wait="${6:-20}"; if http "$url"; then healthy "$n"; return; fi; due "$n" || return; if proc "$pat"; then log "service=$n state=starting_or_unhealthy grace_s=$grace"; sleep "$grace" 9>&-; if http "$url"; then healthy "$n"; return; fi; fi; log "service=$n action=repair"; if proc "$pat"; then pkill -TERM -f "$pat" 2>/dev/null || true; waited=0; while proc "$pat" && [ "$waited" -lt "$stop_wait" ]; do sleep 2 9>&-; waited=$((waited+2)); done; if proc "$pat"; then log "service=$n state=stop_timeout waited_s=$waited action=kill_stale"; pkill -KILL -f "$pat" 2>/dev/null || true; sleep 2 9>&-; if proc "$pat"; then fail "$n"; return; fi; fi; fi; start "$n" "$script"; sleep "$grace" 9>&-; http "$url" && healthy "$n" || fail "$n"; }
check_adb(){ if adb_ok; then prev=$(get adb status unknown); healthy adb; [ "$prev" = healthy ] || "$ROOT/chat-continuity-restore.sh" >/dev/null 2>&1 || true; return; fi; due adb || return; log 'service=adb action=fast_reconnect'; timeout 4 adb connect 127.0.0.1:5556 >/dev/null 2>&1||true; sleep 1 9>&-; adb_ok && healthy adb || fail adb; }
log 'event=start result=ok state=persistent_backoff'
while :; do
 check_supervisor adb_watchdog '[a]db-recovery-watchdog.sh' "$ROOT/adb-recovery-watchdog.sh"
 check_supervisor remote_watchdog '[r]emote-desktop-watchdog.sh' "$ROOT/remote-desktop-watchdog.sh"
 check_supervisor incident_manager '[i]ncident-manager.sh' "$ROOT/incident-manager.sh"
 check_adb
 check_http gateway http://127.0.0.1:18789/healthz '[o]penclaw-gateway' "$ROOT/gateway-start.sh" 120 45
 check_http companion http://127.0.0.1:8765/ 'dist/companion/[s]erver.js' "$ROOT/companion-server.sh" 12 20
 sleep 15 9>&-
done
