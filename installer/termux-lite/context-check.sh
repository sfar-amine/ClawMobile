#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
[ "$#" -ge 1 ] || { echo "usage: $0 AFTER_REVISION [LIMIT]" >&2; exit 64; }
exec python3 "$R/context-store.py" check "$@"
