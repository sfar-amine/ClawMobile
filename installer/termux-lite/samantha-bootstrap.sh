#!/data/data/com.termux/files/usr/bin/bash
# Compatibility entry point. The canonical boot/recovery hierarchy is Root Guardian -> Health Manager.
set -u
export TMPDIR="$HOME/.cache/tmp"; mkdir -p "$TMPDIR"; chmod 700 "$TMPDIR"
ROOT="$HOME/ClawMobile/installer/termux-lite"
if ! pgrep -f '[s]amantha-root-guardian.sh' >/dev/null 2>&1; then
  nohup "$ROOT/samantha-root-guardian.sh" >>"$HOME/.openclaw/guardian/guardian.stderr.log" 2>&1 </dev/null &
fi
