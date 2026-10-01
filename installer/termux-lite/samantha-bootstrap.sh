#!/data/data/com.termux/files/usr/bin/bash
# Compatibility entry point. The canonical boot/recovery hierarchy is Root Guardian -> Health Manager.
set -u
export TMPDIR="$HOME/.cache/tmp"; mkdir -p "$TMPDIR"; chmod 700 "$TMPDIR"
SELF_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
resolve_runtime_root(){
  control="$HOME/.openclaw/tier0/bin/tier0-control.py"
  if [ -x "$control" ]; then
    root="$("$control" root 2>/dev/null || true)"
    [ -n "$root" ] && [ -d "$root" ] && { readlink -f "$root"; return; }
  fi
  printf "%s\n" "$SELF_ROOT"
}
ROOT="$(resolve_runtime_root)"
proc(){ pgrep -f "$1" >/dev/null 2>&1; }
process_uses_script(){ pat="$1"; script="$2"; for pid in $(pgrep -f "$pat" 2>/dev/null); do [ -r "/proc/$pid/cmdline" ] || continue; tr "\0" "\n" <"/proc/$pid/cmdline" 2>/dev/null | grep -Fx -- "$script" >/dev/null 2>&1 && return 0; done; return 1; }
if proc "[s]amantha-root-guardian.sh" && ! process_uses_script "[s]amantha-root-guardian.sh" "$ROOT/samantha-root-guardian.sh"; then
  pkill -TERM -f "[s]amantha-root-guardian.sh" 2>/dev/null || true
  waited=0
  while proc "[s]amantha-root-guardian.sh" && [ "$waited" -lt 8 ]; do sleep 1; waited=$((waited+1)); done
  proc "[s]amantha-root-guardian.sh" && pkill -KILL -f "[s]amantha-root-guardian.sh" 2>/dev/null || true
fi
if ! (proc "[s]amantha-root-guardian.sh" && process_uses_script "[s]amantha-root-guardian.sh" "$ROOT/samantha-root-guardian.sh"); then
  nohup env CLAW_RUNTIME_ROOT="$ROOT" "$ROOT/samantha-root-guardian.sh" >>"$HOME/.openclaw/guardian/guardian.stderr.log" 2>&1 </dev/null &
fi
