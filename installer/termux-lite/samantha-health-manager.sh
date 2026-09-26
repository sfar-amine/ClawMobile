#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="$HOME/ClawMobile/installer/termux-lite"; D="$HOME/.openclaw/health"; LOG="$D/health.log"; S="$D/state"; mkdir -p "$D" "$S"; export TMPDIR="$HOME/.cache/tmp"
exec 9>"$D/health.lock"; flock -n 9 || exit 0; exec 9>&-
log(){ printf '%s component=health-manager %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
proc(){ pgrep -f "$1" >/dev/null 2>&1; }; http(){ timeout 3 curl -fsS "$1" >/dev/null 2>&1; }; adb_ok(){ timeout 3 adb -s 127.0.0.1:5555 get-state 2>/dev/null|grep -qx device; }
now(){ date +%s; }; sf(){ echo "$S/$1.$2"; }; get(){ cat "$(sf "$1" "$2")" 2>/dev/null || echo "${3:-0}"; }; put(){ printf '%s' "$3" >"$(sf "$1" "$2")"; }
healthy(){ n="$1"; [ "$(get "$n" status unknown)" = healthy ] || log "service=$n state=healthy"; put "$n" status healthy; put "$n" failures 0; put "$n" next 0; }
fail(){ n="$1"; c=$(( $(get "$n" failures 0)+1 )); [ "$c" -gt 6 ] && c=6; delay=$((15*(1<<(c-1)))); [ "$delay" -gt 900 ] && delay=900; put "$n" failures "$c"; put "$n" status degraded; put "$n" next $(( $(now)+delay )); log "service=$n state=degraded failures=$c retry_in_s=$delay"; }
due(){ [ "$(now)" -ge "$(get "$1" next 0)" ]; }
start(){ nohup "$2" >>"$D/$1.stderr.log" 2>&1 </dev/null & }
check_supervisor(){ n="$1"; pat="$2"; script="$3"; if proc "$pat"; then healthy "$n"; return; fi; due "$n" || return; log "service=$n action=start"; start "$n" "$script"; sleep 3; proc "$pat" && healthy "$n" || fail "$n"; }
check_http(){ n="$1"; url="$2"; pat="$3"; script="$4"; if http "$url"; then healthy "$n"; return; fi; due "$n" || return; log "service=$n action=repair"; proc "$pat" && pkill -f "$pat" 2>/dev/null || true; start "$n" "$script"; sleep 6; http "$url" && healthy "$n" || fail "$n"; }
check_adb(){ if adb_ok; then healthy adb; return; fi; due adb || return; log 'service=adb action=fast_reconnect'; timeout 4 adb connect 127.0.0.1:5555 >/dev/null 2>&1||true; sleep 1; adb_ok && healthy adb || fail adb; }
log 'event=start result=ok state=persistent_backoff'
while :; do
 check_supervisor adb_supervisor '[a]db-recovery-supervisor.sh' "$ROOT/adb-recovery-supervisor.sh"
 check_supervisor remote_supervisor '[r]emote-desktop-supervisor.sh' "$ROOT/remote-desktop-supervisor.sh"
 check_adb
 check_http gateway http://127.0.0.1:18789/ '[o]penclaw-gateway' "$ROOT/gateway-start.sh"
 check_http companion http://127.0.0.1:8765/ 'dist/companion/[s]erver.js' "$ROOT/companion-server.sh"
 sleep 15
done
