#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
TIER0="$HOME/.openclaw/tier0"; CONTROL="$TIER0/bin/tier0-control.py"
restart_core(){
python3 - <<'PY'
from pathlib import Path
import os,signal,time

need=('samantha-root-guardian.sh','samantha-health-manager.sh','incident-orchestrator-worker.sh')
me=os.getpid()

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

rows={}
for p in Path('/proc').iterdir():
    if p.name.isdigit():
        r=row(p.name)
        if r: rows[r['pid']]=r
roots={pid for pid,r in rows.items() if pid!=me and any('/'+n in r['args'] for n in need)}
targets=set(roots)
changed=True
while changed:
    changed=False
    for pid,r in rows.items():
        if r['ppid'] in targets and pid not in targets:
            targets.add(pid); changed=True
identities={pid:rows[pid]['start'] for pid in targets}

def same(pid):
    r=row(pid)
    return bool(r and r['start']==identities.get(pid))

# Children first so helpers cannot outlive their supervisor and retain lock descriptors.
depth={}
def d(pid):
    if pid in depth:return depth[pid]
    parent=rows.get(pid,{}).get('ppid')
    depth[pid]=1+d(parent) if parent in targets else 0
    return depth[pid]
order=sorted(targets,key=d,reverse=True)
for sig,wait_s in ((signal.SIGTERM,1),(signal.SIGKILL,1)):
    for pid in order:
        if same(pid):
            try: os.kill(pid,sig)
            except ProcessLookupError: pass
    time.sleep(wait_s)
    if not any(same(pid) for pid in order):break
survivors=[pid for pid in order if same(pid)]
if survivors: raise SystemExit('core_processes_survived_restart_boundary:'+','.join(map(str,survivors)))
PY
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
wait_for_lock_release "$HOME/.openclaw/guardian/guardian.lock"
wait_for_lock_release "$HOME/.openclaw/health/health.lock"
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
if ! pgrep -f '[t]ier0-watchdog.py' >/dev/null 2>&1; then
  nohup "$TIER0/bin/tier0-watchdog.py" >>"$TIER0/watchdog.stderr.log" 2>&1 </dev/null &
fi
mkdir -p "$HOME/.openclaw/continuity"
printf '%s boot=tier0 event=started release=%s\n' "$(date -Iseconds)" "$(basename "$(dirname "$ROOT")")" >>"$HOME/.openclaw/continuity/boot.log"
nohup "$ROOT/boot-continuity-recovery.sh" >>"$HOME/.openclaw/continuity/boot-recovery.stderr.log" 2>&1 </dev/null &
exec "$ROOT/samantha-root-guardian.sh"
