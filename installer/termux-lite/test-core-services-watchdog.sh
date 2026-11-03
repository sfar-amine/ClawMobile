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

# --gateway-only: the mode samantha-health-manager.sh supervises. The Companion belongs to the health manager
# and, while it lives, the Gateway to the Companion's own watchdog: this watchdog acts only without a Companion.
# Every earlier case's processes are reaped first: pgrep sees the whole host.
reap(){ local p; for p in "${PIDS[@]}"; do kill -KILL "$p" 2>/dev/null || true; done; PIDS=(); for p in "$T"/*/new-gw.pid; do [ -f "$p" ] && kill -KILL "$(cat "$p")" 2>/dev/null; rm -f "$p"; done; sleep 0.3; }
gw_only(){ local t="$1"; shift; TICKS_ARG="$t" run_wd_args --gateway-only "$@"; }
run_wd_args(){
  env -u OPENCLAW_HOME -u SAMANTHA_DEPLOY_LOCK_FD HOME="$C/home" PATH="$C/bin:$PATH" CLAW_RUNTIME_ROOT="$C/root" \
    GATEWAY_PORT="$PORT" CORE_SERVICES_WATCHDOG_TICKS="$TICKS_ARG" CORE_SERVICES_WATCHDOG_INTERVAL_S=0 \
    CORE_SERVICES_GATEWAY_STOP_WAIT_S="${STOP_WAIT:-10}" timeout 60 "$BASH_BIN" "$C/root/core-services-watchdog.sh" "$@" </dev/null
}
singleton_free(){ "$BASH_BIN" -c 'exec 8>"$1"; flock -n 8' _ "$C/home/.openclaw/watchdogs/core-services.lock"; }
no_companion_start(){ [ ! -e "$C/companion-starts" ] || fail "$1: --gateway-only must never start the Companion"; }
# Wait until no Companion-like process remains on the host (killed doubles are reaped asynchronously).
no_companion_left(){ local i; for i in $(seq 50); do pgrep -f 'dist/companion/[s]erver.js' >/dev/null || return 0; sleep 0.1; done
  fail "a process matching the Companion pattern is still running on this host: $(pgrep -af 'dist/companion/[s]erver.js' | cut -c1-120 | head -3)"; }
ps_no_gw(){ printf '  PID ELAPSED COMMAND\n%s 900 bash -c sleep 600; : openclaw-gateway\n' "$DECOY" >"$C/ps.out"; }

# 10. Companion alive, Gateway mute beyond grace: the Companion's watchdog owns it, nothing here.
reap; setup gw_companion; ps_ages 300; gw_only 3
nothing_done gw_companion; no_companion_start gw_companion
! LOGF | grep -q gateway_port_closed || fail "gw_companion: no observation while the Companion owns the Gateway"
LOGF | grep -q 'event=gateway_owner owner=companion scope=gateway' || fail "gw_companion: owner hand-off not logged"
[ "$(LOGF | grep -c 'event=gateway_owner')" = 1 ] || fail "gw_companion: owner must be logged on transitions only"
lock_free || fail "gw_companion: the runtime lease must never be taken"
echo "ok 10 --gateway-only, Companion alive: Gateway left to the Companion, nothing done"

# 11. Companion absent, Gateway mute beyond grace: exact PID stopped and restarted, Companion untouched.
reap; setup gw_orphan; kill -KILL "$CP"; no_companion_left; ps_ages 120; gw_only 2
! alive "$GW" || fail "gw_orphan: mute Gateway must be stopped"
[ "$(cat "$C/starts" 2>/dev/null)" = start ] || fail "gw_orphan: gateway-start.sh must run exactly once"
LOGF | grep -q "event=gateway_restarted cause=gateway_alive_port_closed stopped=$GW" || fail "gw_orphan: restart not logged"
LOGF | grep -q 'event=gateway_owner owner=core-services scope=gateway' || fail "gw_orphan: owner not logged"
no_companion_start gw_orphan; lock_free || fail "gw_orphan: lease not released"
NEW="$(cat "$C/new-gw.pid")"; alive "$NEW" || fail "gw_orphan: relaunched Gateway should run"
singleton_free || fail "gw_orphan: the relaunched Gateway must not hold the watchdog singleton lock"
[ "$(awk '{print $4}' "/proc/$NEW/stat")" != "$$" ] || fail "gw_orphan: relaunched Gateway must be detached"
echo "ok 11 --gateway-only, Companion absent, mute Gateway: restarted under the lease, Companion never started"

# 12. Companion absent and no Gateway at all: one start under the lease.
reap; setup gw_absent; kill -KILL "$CP" "$GW"; no_companion_left; ps_no_gw; gw_only 2
[ "$(cat "$C/starts" 2>/dev/null)" = start ] || fail "gw_absent: gateway-start.sh must run exactly once"
LOGF | grep -q 'event=recovered service=gw cause=gateway_absent_companion_absent' || fail "gw_absent: recovery not logged"
grep -qx core_service "$C/notifications" || fail "gw_absent: recovery notification missing"
no_companion_start gw_absent; lock_free || fail "gw_absent: lease not released"; singleton_free || fail "gw_absent: singleton lock inherited"
echo "ok 12 --gateway-only, Companion and Gateway absent: Gateway started once, Companion never started"

# 13. Same, while the health manager repairs the Companion under the lease: nothing started.
reap; setup gw_hm_lease; kill -KILL "$CP" "$GW"; no_companion_left; ps_no_gw
mkfifo "$C/lease.in"
HOME="$C/home" python3 "$R/runtime_mode.py" --repair-lease <"$C/lease.in" >"$C/lease.out" 2>/dev/null & PIDS+=("$!"); LEASE=$!
exec 6>"$C/lease.in"
for _ in $(seq 50); do grep -q acquired "$C/lease.out" 2>/dev/null && break; sleep 0.1; done
grep -q acquired "$C/lease.out" || fail "test setup: lease not acquired"
gw_only 2; exec 6>&-; wait "$LEASE" 2>/dev/null || true
[ ! -e "$C/starts" ] || fail "gw_hm_lease: no start while the Companion repair holds the lease"
LOGF | grep -q 'event=gateway_recovery_deferred cause=gateway_absent_companion_absent reason=lock_busy' || fail "gw_hm_lease: deferral not logged"
no_companion_start gw_hm_lease
echo "ok 13 --gateway-only, Companion repair lease held: deferred, nothing started"

# 14. A Companion that appears while the lease is being taken keeps the Gateway (re-check under the lease).
reap; setup gw_race; kill -KILL "$CP" "$GW"; no_companion_left; ps_no_gw; rm -f "$C/root/runtime_mode.py"
cat >"$C/root/runtime_mode.py" <<EOF
import os,subprocess,sys
p=subprocess.Popen(["$BASH_BIN","-c",'exec -a "node dist/companion/server.js" sleep 600'],start_new_session=True)
open("$C/race-cp.pid","w").write(str(p.pid)); import time; time.sleep(0.3)
os.execvp(sys.executable,[sys.executable,"$R/runtime_mode.py"]+sys.argv[1:])
EOF
gw_only 1; [ -f "$C/race-cp.pid" ] && PIDS+=("$(cat "$C/race-cp.pid")")
[ ! -e "$C/starts" ] || fail "gw_race: no start once the Companion is back"
LOGF | grep -q 'event=gateway_recovery_skipped cause=gateway_absent_companion_absent reason=companion_owns_gateway' || fail "gw_race: skip not logged"
lock_free || fail "gw_race: lease not released"
echo "ok 14 --gateway-only, Companion back under the lease: no start"

# 15. A gateway-start.sh still preparing (no openclaw-gateway title yet) is a Gateway: no second start.
reap; setup gw_starting; kill -KILL "$CP" "$GW"; no_companion_left
printf '  PID ELAPSED COMMAND\n%s 3 /data/data/com.termux/files/usr/bin/bash %s/root/gateway-start.sh\n' "$DECOY" "$C" >"$C/ps.out"; gw_only 2
[ ! -e "$C/starts" ] || fail "gw_starting: a Gateway being started must not be started twice"
lock_free || fail "gw_starting: lease must not be taken"
echo "ok 15 --gateway-only, gateway-start.sh in progress: no second start"

# 16. Singleton: a running watchdog keeps its lock, a second one exits at once; unknown option refused.
reap; setup gw_single; ps_ages 300
( exec env -u OPENCLAW_HOME -u SAMANTHA_DEPLOY_LOCK_FD HOME="$C/home" PATH="$C/bin:$PATH" CLAW_RUNTIME_ROOT="$C/root" GATEWAY_PORT="$PORT" \
    CORE_SERVICES_WATCHDOG_TICKS=0 CORE_SERVICES_WATCHDOG_INTERVAL_S=1 "$BASH_BIN" "$C/root/core-services-watchdog.sh" --gateway-only </dev/null ) & PIDS+=("$!"); FIRST=$!
for _ in $(seq 50); do LOGF | grep -q 'event=start' && break; sleep 0.1; done
! singleton_free || fail "gw_single: the running watchdog must hold the singleton lock"
TICKS_ARG=1 run_wd_args --gateway-only; rc=$?
[ "$rc" = 0 ] && [ "$(LOGF | grep -c 'event=start')" = 1 ] || fail "gw_single: a second instance must exit without starting (rc=$rc)"
for p in $(pgrep -f "$C/root/[c]ore-services-watchdog.sh"); do kill -TERM "$p" 2>/dev/null; done; wait "$FIRST" 2>/dev/null || true
for _ in $(seq 50); do pgrep -f "$C/root/[c]ore-services-watchdog.sh" >/dev/null || break; sleep 0.1; done
! pgrep -f "$C/root/[c]ore-services-watchdog.sh" >/dev/null || fail "gw_single: the first watchdog did not stop"
singleton_free || fail "gw_single: lock must be released when the watchdog stops"
set +e; TICKS_ARG=1 run_wd_args --bogus 2>/dev/null; rc=$?; set -e
[ "$rc" = 64 ] || fail "gw_single: unknown option must be refused (rc=$rc)"
echo "ok 16 singleton held for the life of the loop; second instance exits; unknown option refused"

echo "core-services watchdog gateway port tests passed"
