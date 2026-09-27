#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
usage(){ echo "usage: $0 --after REVISION [--limit N] | --session SESSION_ID [--surface chat|work|voice|openclaw] [--limit N]" >&2; exit 64; }
mode=""; value=""; surface="chat"; limit=500
while [ "$#" -gt 0 ]; do
 case "$1" in
  --after) mode=after; value="$2"; shift 2;;
  --session) mode=session; value="$2"; shift 2;;
  --surface) surface="$2"; shift 2;;
  --limit) limit="$2"; shift 2;;
  *) usage;;
 esac
done
[ -n "$mode" ] && [ -n "$value" ] || usage
if [ "$mode" = after ]; then exec python3 "$R/context-store.py" check "$value" "$limit"; fi
cur="$(python3 "$R/context-store.py" cursor-get "$value")"
after="$(printf '%s' "$cur" | python3 -c 'import json,sys; x=json.load(sys.stdin); print(0 if x is None else x["lastSeenRevision"])')"
python3 "$R/context-store.py" check "$after" "$limit"
