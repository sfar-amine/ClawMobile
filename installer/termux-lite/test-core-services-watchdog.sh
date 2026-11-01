#!/data/data/com.termux/files/usr/bin/bash
# core-services-watchdog.sh: a live Gateway process whose port 18789 stays closed
# (in-process start/restart failure, « Process will stay alive ») is stopped by its
# exact PID and restarted through gateway-start.sh, only after the 60 s grace and two
# consecutive observations, and never while the canonical deploy lock is held
# (deployment, QA campaign or Companion runtime repair lease) or Tier0 is stopped.
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
. "$R/host_test_support.sh"  # shebangs Termux des doubles adaptés hors Termux (CI, conteneurs)
BASH_BIN="$(host_bash)"
T="$(mktemp -d)"
PIDS=()
cleanup(){ local p; for p in "${PIDS[@]}"; do kill -KILL "$p" 2>/dev/null || true; done; for p in "$T"/*/new-gw.pid; do [ -f "$p" ] && kill -KILL "$(cat "$p")" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT
fail(){ echo "FAIL: $*" >&2; [ -n "${C:-}" ] && [ -f "$C/home/.openclaw/watchdogs/core-services.log" ] && sed 's/^/  log| /' "$C/home/.openclaw/watchdogs/core-services.log" >&2; exit 1; }
free_port(){ python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
spawn(){ "$@" & PIDS+=("$!"); LAST=$!; disown "$LAST"; }
alive(){ kill -0 "$1" 2>/dev/null && [ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != Z ]; }

# One isolated runtime per case: HOME, release root with doubles, fake ps (controlled ages, real PIDs).
setup(){
  C="$T/$1"; mkdir -p "$C/home/.openclaw/deploys" "$C/root" "$C/bin"; chmod 700 "$C/home/.openclaw" "$C/home/.openclaw/deploys"
  : >"$C/home/.openclaw/deploys/companion-deploy.lock"; chmod 600 "$C/home/.openclaw/deploys/companion-deploy.lock"
  cp "$R/core-services-watchdog.sh" "$C/root/"; ln -s "$R/runtime_mode.py" "$C/root/runtime_mode.py"
  cat >"$C/root/gateway-start.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
echo start >>"$C/starts"; echo \$\$ >"$C/new-gw.pid"
exec -a openclaw-gateway sleep 600
EOF
  cat >"$C/root/companion-server.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
echo start >>"$C/companion-starts"
EOF
  cat >"$C/root/incident-notify.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
printf '%s\n' "\$1" >>"$C/notifications"
EOF
  cat >"$C/bin/ps" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
cat "$C/ps.out"
EOF
  chmod +x "$C/root/"*.sh "$C/bin/ps"; host_adapt_shebangs "$C/root/gateway-start.sh" "$C/root/companion-server.sh" "$C/root/incident-notify.sh" "$C/bin/ps"
  # Real processes: the Gateway (S24 process title), the Companion and a diagnostic shell decoy.
  spawn "$BASH_BIN" -c "${2:-} exec -a openclaw-gateway sleep 600"; GW=$LAST
  spawn "$BASH_BIN" -c 'exec -a "node dist/companion/server.js" sleep 600'; CP=$LAST
  spawn sleep 600; DECOY=$LAST  # its ps line below is a diagnostic shell mentioning the Gateway
  sleep 0.3
  PORT="$(free_port)"
}
ps_ages(){ printf '  PID ELAPSED COMMAND\n%s %s /data/data/com.termux/files/usr/glibc/lib/ld-linux-aarch64.so.1 --library-path /data/data/com.termux/files/usr/glibc/lib openclaw-gateway\n%s 900 bash -c sleep 600; : openclaw-gateway\n%s 900 node dist/companion/server.js 600\n' "$GW" "$1" "$DECOY" "$CP" >"$C/ps.out"; }
run_wd(){
  env -u OPENCLAW_HOME -u SAMANTHA_DEPLOY_LOCK_FD HOME="$C/home" PATH="$C/bin:$PATH" CLAW_RUNTIME_ROOT="$C/root" \
    GATEWAY_PORT="$PORT" CORE_SERVICES_WATCHDOG_TICKS="$1" CORE_SERVICES_WATCHDOG_INTERVAL_S=0 \
    CORE_SERVICES_GATEWAY_STOP_WAIT_S="${STOP_WAIT:-10}" timeout 60 "$BASH_BIN" "$C/root/core-services-watchdog.sh" </dev/null
}
LOGF(){ cat "$C/home/.openclaw/watchdogs/core-services.log" 2>/dev/null || true; }
nothing_done(){
  alive "$GW" || fail "$1: the Gateway process must not be stopped"
  [ ! -e "$C/starts" ] || fail "$1: gateway-start.sh must not run"
  ! LOGF | grep -q 'event=gateway_stop' || fail "$1: no stop may be logged"
}
lock_free(){ "$BASH_BIN" -c 'exec 8<>"$1"; flock -n 8' _ "$C/home/.openclaw/deploys/companion-deploy.lock"; }

# 1. Process alive + port open: nothing, no observation.
setup open
spawn python3 -c 'import socket,sys,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(("127.0.0.1",int(sys.argv[1])));s.listen();time.sleep(600)' "$PORT"
sleep 0.5; ps_ages 600; run_wd 3
nothing_done open; ! LOGF | grep -q gateway_port_closed || fail "open port must not count as an observation"
echo "ok 1 alive + port open: nothing"

# 2. Process alive + port closed within the 60 s grace: nothing.
setup grace; ps_ages 59; run_wd 3
nothing_done grace; ! LOGF | grep -q gateway_port_closed || fail "a Gateway in its grace must not be observed"
echo "ok 2 alive + port closed within grace: nothing"

# 3. Beyond grace, a single observation is not enough.
setup single; ps_ages 120; run_wd 1
nothing_done single; LOGF | grep -q "event=gateway_port_closed cause=gateway_alive_port_closed port=$PORT strike=1/2 pids=$GW" || fail "first observation not logged"
echo "ok 3 one observation beyond grace: logged, nothing stopped"

# 4. Beyond grace, two consecutive observations: exact PID stopped (TERM), then gateway-start.sh.
setup recover; ps_ages 120; run_wd 2
! alive "$GW" || fail "orphan Gateway PID $GW must be stopped"
alive "$DECOY" || fail "a shell merely mentioning the Gateway must never be stopped"
alive "$CP" || fail "the Companion must not be touched"
[ "$(cat "$C/starts" 2>/dev/null)" = start ] || fail "gateway-start.sh must run exactly once"
LOGF | grep -q "event=gateway_stop cause=gateway_alive_port_closed pid=$GW age_s=120 signal=TERM" || fail "TERM not logged"
! LOGF | grep -q 'signal=KILL' || fail "a Gateway that honours TERM must not be killed"
LOGF | grep -q "event=gateway_restarted cause=gateway_alive_port_closed stopped=$GW" || fail "restart not logged with its cause"
grep -qx core_service "$C/notifications" || fail "recovery notification missing"
alive "$(cat "$C/new-gw.pid")" || fail "relaunched Gateway should be running"
lock_free || fail "the runtime lease must be released (not inherited by the relaunched Gateway)"
[ ! -e "$C/companion-starts" ] || fail "the Companion is alive and must not be restarted"
echo "ok 4 two observations beyond grace: PID $GW stopped, gateway-start.sh relaunched, lock released"

# 5. A Gateway that ignores TERM is killed after the bounded wait.
setup stubborn 'trap "" TERM;'; ps_ages 300; STOP_WAIT=2 run_wd 2
! alive "$GW" || fail "stubborn Gateway must be killed"
LOGF | grep -q "pid=$GW signal=KILL" || fail "KILL escalation not logged"
[ "$(cat "$C/starts" 2>/dev/null)" = start ] || fail "gateway-start.sh must run after the escalation"
echo "ok 5 TERM ignored: SIGKILL after the bounded wait, then relaunch"

# 6. Deployment in progress (companion-deploy.sh holds the lock exclusively): nothing.
setup deploy; ps_ages 120
exec 7<>"$C/home/.openclaw/deploys/companion-deploy.lock"; flock -n 7
run_wd 2; exec 7>&-
nothing_done deploy; LOGF | grep -q "event=gateway_recovery_deferred cause=gateway_alive_port_closed reason=lock_busy" || fail "deploy: deferral not logged"
echo "ok 6 deployment lock held: deferred, nothing stopped"

# 7. Companion restart in progress: it holds the same lock through runtime_mode.py --repair-lease.
setup companion; ps_ages 120
mkfifo "$C/lease.in"
HOME="$C/home" python3 "$R/runtime_mode.py" --repair-lease <"$C/lease.in" >"$C/lease.out" 2>/dev/null & PIDS+=("$!"); LEASE=$!
exec 6>"$C/lease.in"
for _ in $(seq 50); do grep -q acquired "$C/lease.out" 2>/dev/null && break; sleep 0.1; done
grep -q acquired "$C/lease.out" || fail "test setup: Companion lease not acquired"
run_wd 2; exec 6>&-; wait "$LEASE" 2>/dev/null || true
nothing_done companion; LOGF | grep -q "reason=lock_busy" || fail "companion: deferral not logged"
echo "ok 7 Companion runtime repair lease held: deferred, nothing stopped"

# 8. QA campaign holds the same lock shared: nothing.
setup campaign; ps_ages 120
exec 7<"$C/home/.openclaw/deploys/companion-deploy.lock"; flock -sn 7
run_wd 2; exec 7<&-
nothing_done campaign; LOGF | grep -q "reason=lock_busy" || fail "campaign: deferral not logged"
echo "ok 8 QA campaign shared lock: deferred, nothing stopped"

# 9. Tier0 emergency stop: nothing.
setup estop; ps_ages 120; mkdir -p "$C/home/.openclaw/tier0"; echo '{"enabled": true}' >"$C/home/.openclaw/tier0/emergency-stop.json"
run_wd 2
nothing_done estop; LOGF | grep -q "reason=emergency_stop" || fail "emergency stop: deferral not logged"
echo "ok 9 Tier0 emergency stop: deferred, nothing stopped"

echo "core-services watchdog gateway port tests passed"
