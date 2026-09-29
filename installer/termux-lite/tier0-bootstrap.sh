#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
TIER0="$HOME/.openclaw/tier0"; CONTROL="$TIER0/bin/tier0-control.py"
restart_core(){
python3 - <<'PY'
import os,signal,subprocess
need=('samantha-root-guardian.sh','samantha-health-manager.sh','incident-orchestrator-worker.sh')
me=os.getpid()
for line in subprocess.run(['ps','-Ao','pid,args'],capture_output=True,text=True).stdout.splitlines()[1:]:
    try: pid_s,args=line.strip().split(None,1);pid=int(pid_s)
    except Exception: continue
    if pid==me: continue
    if any('/'+n in args for n in need):
        try: os.kill(pid,signal.SIGTERM)
        except ProcessLookupError: pass
PY
sleep 3
nohup "$0" >/dev/null 2>&1 </dev/null &
exit 0
}
[ "${1:-}" = "--restart-core" ] && restart_core
ROOT="$("$CONTROL" root)"
export CLAW_RUNTIME_ROOT="$ROOT"
export TMPDIR="$HOME/.cache/tmp"; mkdir -p "$TMPDIR"; chmod 700 "$TMPDIR"
if ! pgrep -f '[t]ier0-watchdog.py' >/dev/null 2>&1; then
  nohup "$TIER0/bin/tier0-watchdog.py" >>"$TIER0/watchdog.stderr.log" 2>&1 </dev/null &
fi
mkdir -p "$HOME/.openclaw/continuity"
printf '%s boot=tier0 event=started release=%s\n' "$(date -Iseconds)" "$(basename "$(dirname "$ROOT")")" >>"$HOME/.openclaw/continuity/boot.log"
nohup "$ROOT/boot-continuity-recovery.sh" >>"$HOME/.openclaw/continuity/boot-recovery.stderr.log" 2>&1 </dev/null &
exec "$ROOT/samantha-root-guardian.sh"
