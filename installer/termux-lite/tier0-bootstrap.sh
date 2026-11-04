#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
TIER0="$HOME/.openclaw/tier0"; CONTROL="$TIER0/bin/tier0-control.py"
restart_core(){
summary="$(python3 - <<'PY'
from pathlib import Path
import os,signal,time

need=('samantha-root-guardian.sh','samantha-health-manager.sh','incident-orchestrator-worker.sh')

def row(pid):
    try:
        p=Path('/proc')/str(pid)
        fields=(p/'stat').read_text().rsplit(')',1)[1].split()
        return {
            'pid':int(pid),
            'ppid':int(fields[1]),
            'start':fields[19],
            'args':(p/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace'),
        }
    except (OSError,ValueError,IndexError):
        return None

def supervisor(r):
    return any('/'+n in r['args'] for n in need)

def own_chain(rows,me):
    """This restart and every non-supervisor process it runs under (bootstrap shell, soak watchdog,
    deploy). When the boundary is requested from inside the supervisor tree (the soak watchdog's rollback
    Popen()s it), killing that chain would kill the relaunch below with it and leave the device with no
    supervisor at all. The supervisors themselves stay targets: stopping a parent never stops its child."""
    chain={me};pid=rows.get(me,{}).get('ppid')
    while pid and pid>1 and pid in rows and pid not in chain:
        chain.add(pid);pid=rows[pid]['ppid']
    return {pid for pid in chain if pid==me or not supervisor(rows[pid])}

def plan(rows,me):
    keep=own_chain(rows,me)
    roots={pid for pid,r in rows.items() if pid not in keep and supervisor(r)}
    targets=set(roots)
    changed=True
    while changed:
        changed=False
        for pid,r in rows.items():
            if r['ppid'] in targets and pid not in targets and pid not in keep:
                targets.add(pid); changed=True
    # Children first so helpers cannot outlive their supervisor and retain lock descriptors.
    depth={}
    def d(pid):
        if pid in depth:return depth[pid]
        parent=rows.get(pid,{}).get('ppid')
        depth[pid]=1+d(parent) if parent in targets else 0
        return depth[pid]
    return sorted(targets,key=d,reverse=True),keep-{me}

def main():
    me=os.getpid()
    rows={}
    for p in Path('/proc').iterdir():
        if p.name.isdigit():
            r=row(p.name)
            if r: rows[r['pid']]=r
    order,spared=plan(rows,me)
    identities={pid:rows[pid]['start'] for pid in order}
    def same(pid):
        r=row(pid)
        return bool(r and r['start']==identities.get(pid))
    for sig,wait_s in ((signal.SIGTERM,1),(signal.SIGKILL,1)):
        for pid in order:
            if same(pid):
                try: os.kill(pid,sig)
                except ProcessLookupError: pass
        time.sleep(wait_s)
        if not any(same(pid) for pid in order):break
    survivors=[pid for pid in order if same(pid)]
    if survivors: raise SystemExit('core_processes_survived_restart_boundary:'+','.join(map(str,survivors)))
    print(f'stopped={len(order)} spared_own_chain={len(spared)}')

if __name__=='__main__':main()
PY
)"
mkdir -p "$HOME/.openclaw/continuity"
printf '%s boot=tier0 event=restart_core %s\n' "$(date -Iseconds)" "$summary" >>"$HOME/.openclaw/continuity/boot.log"
wait_for_lock_release(){
  lock="$1"
  waited=0
  while true; do
    exec 8>"$lock"
    if flock -n 8 2>/dev/null; then
      flock -u 8 2>/dev/null || true
      exec 8>&-
      return 0
    fi
    exec 8>&-
    waited=$((waited+1))
    [ "$waited" -ge 20 ] && { echo "lock_release_timeout:$lock" >&2; return 1; }
    sleep 1
  done
}
# A holder that outlived the boundary must not leave the device with no supervisor at all: relaunch
# anyway (each supervisor keeps its own singleton lock) and leave the timeout in the boot log.
for lock in "$HOME/.openclaw/guardian/guardian.lock" "$HOME/.openclaw/health/health.lock"; do
  wait_for_lock_release "$lock" || printf '%s boot=tier0 event=restart_core_lock_timeout lock=%s\n' "$(date -Iseconds)" "$lock" >>"$HOME/.openclaw/continuity/boot.log"
done
nohup "$0" >/dev/null 2>&1 </dev/null &
exit 0
}
[ "${1:-}" = "--restart-core" ] && restart_core
ROOT="$("$CONTROL" root)"
export CLAW_RUNTIME_ROOT="$ROOT"
export TMPDIR="$HOME/.cache/tmp"; mkdir -p "$TMPDIR"; chmod 700 "$TMPDIR"
if timeout 3 adb -s 127.0.0.1:5556 get-state 2>/dev/null | grep -qx device; then
  timeout 12 "$ROOT/android-network-mutation-guard.py" ensure-termux-background >/dev/null 2>&1 || true
fi
# I10: one closed, read-only receipt per Android boot. Drift is reported and
# existing owners remain responsible for repair.
timeout 30 python3 "$ROOT/android-startup-check.py" >/dev/null 2>&1 || true
if ! pgrep -f '[t]ier0-watchdog.py' >/dev/null 2>&1; then
  nohup "$TIER0/bin/tier0-watchdog.py" >>"$TIER0/watchdog.stderr.log" 2>&1 </dev/null &
fi
mkdir -p "$HOME/.openclaw/continuity"
printf '%s boot=tier0 event=started release=%s\n' "$(date -Iseconds)" "$(basename "$(dirname "$ROOT")")" >>"$HOME/.openclaw/continuity/boot.log"
exec "$ROOT/samantha-root-guardian.sh"
