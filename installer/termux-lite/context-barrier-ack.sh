#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
[ "$#" -eq 3 ] || { echo "usage: $0 SESSION_ID SURFACE REVISION" >&2; exit 64; }
exec python3 "$R/context-store.py" cursor-set "$1" "$2" "$3"
