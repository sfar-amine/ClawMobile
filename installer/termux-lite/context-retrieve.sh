#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec python3 "$R/context-retrieve.py" "$@"
