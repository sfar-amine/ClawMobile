#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="${SAMANTHA_CONTEXT_ROOT:-$HOME/.openclaw/context-sync}"
Q="$ROOT/pending"; P="$ROOT/processed"; S="$ROOT/state"
mkdir -p "$Q" "$P" "$S"; chmod 700 "$ROOT" "$Q" "$P" "$S"
usage(){ echo "usage: $0 <chat|work|voice|openclaw> <decision|learning|open_thread|completed_action|constraint|checkpoint> [--supersedes EVENT_ID] <text>" >&2; exit 64; }
[ "$#" -ge 3 ] || usage
surface="$1"; kind="$2"; shift 2
case "$surface" in chat|work|voice|openclaw) ;; *) usage;; esac
case "$kind" in decision|learning|open_thread|completed_action|constraint|checkpoint) ;; *) usage;; esac
supersedes=""
if [ "${1:-}" = "--supersedes" ]; then
  [ "$#" -ge 3 ] || usage; supersedes="$2"; shift 2
  printf '%s' "$supersedes" | grep -Eq '^[0-9a-f]{64}$' || usage
fi
body="$*"; [ -n "$body" ] || usage
# Fail closed on common secret/payment/authentication payloads.
if printf '%s' "$body" | grep -Eqi '(password|passwd|otp|one[- ]?time|cvv|cvc|authorization:[[:space:]]*bearer|bearer[[:space:]]+[A-Za-z0-9._-]+|api[_ -]?key|cookie:|-----BEGIN .*PRIVATE KEY-----|(^|[^0-9])([0-9][ -]?){13,19}([^0-9]|$))'; then
  echo "refusing secret-like context payload" >&2; exit 65
fi
id="$(printf '%s\0%s\0%s\0%s' "$surface" "$kind" "$supersedes" "$body" | sha256sum | awk '{print $1}')"
[ -e "$Q/$id.json" ] || [ -e "$P/$id.json" ] || python3 - "$Q/$id.json.tmp" "$surface" "$kind" "$body" "$id" "$supersedes" <<'PY'
import json,sys,os,datetime
tmp,surface,kind,body,eid,supersedes=sys.argv[1:]
obj={"version":2,"id":eid,"surface":surface,"kind":kind,"text":body,"createdAt":datetime.datetime.now(datetime.timezone.utc).isoformat()}
if supersedes: obj["supersedes"]=supersedes
with open(tmp,"x") as f: json.dump(obj,f,ensure_ascii=False,separators=(",",":"))
os.chmod(tmp,0o600); os.replace(tmp,tmp[:-4])
PY
printf '%s\n' "$id"
