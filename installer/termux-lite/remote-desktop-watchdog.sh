#!/data/data/com.termux/files/usr/bin/bash
set -eu
cd "$HOME" || exit 70
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec python3 "$ROOT/remote-desktop-control.py" supervise --watchdog-tag "$ROOT/remote-desktop-watchdog.sh"
