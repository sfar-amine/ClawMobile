#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="${SAMANTHA_CONTEXT_ROOT:-$HOME/.openclaw/context-sync}"
Q="$ROOT/pending"; P="$ROOT/processed"; S="$ROOT/state"
usage(){ echo "usage: $0 <chat|work|voice|openclaw|claude|codex|app> <decision|learning|open_thread|completed_action|constraint|checkpoint> [--supersedes EVENT_ID] [--session COMPANION_SESSION_ID] <text>" >&2; exit 64; }
[ "$#" -ge 3 ] || usage
surface="$1"; kind="$2"; shift 2
case "$surface" in chat|work|voice|openclaw|claude|codex|app) ;; *) usage;; esac
case "$kind" in decision|learning|open_thread|completed_action|constraint|checkpoint) ;; *) usage;; esac
supersedes=""; session=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --supersedes)
      [ "$#" -ge 3 ] && [ -z "$supersedes" ] || usage
      supersedes="$2"; shift 2
      [[ "$supersedes" =~ ^[0-9a-f]{64}$ ]] || usage;;
    --session)
      [ "$#" -ge 3 ] && [ -z "$session" ] && [ "$kind" = open_thread ] || usage
      session="$2"; shift 2
      [[ "$session" =~ ^[A-Za-z0-9_-]{1,80}$ ]] || usage;;
    --*) usage;;
    *) break;;
  esac
done
body="$*"; [ -n "$body" ] || usage
# Fail closed on common secret/payment/authentication payloads.
if printf '%s' "$body" | grep -Eqi '(password|passwd|otp|one[- ]?time|cvv|cvc|authorization:[[:space:]]*bearer|bearer[[:space:]]+[A-Za-z0-9._-]+|api[_ -]?key|cookie:|-----BEGIN .*PRIVATE KEY-----|(^|[^0-9])([0-9][ -]?){13,19}([^0-9]|$))'; then
  echo "refusing secret-like context payload" >&2; exit 65
fi
mkdir -p "$Q" "$P" "$S"; chmod 700 "$ROOT" "$Q" "$P" "$S"
if [ -n "$session" ]; then
  id="$(printf '%s\0%s\0%s\0%s\0companion-session\0%s' "$surface" "$kind" "$supersedes" "$body" "$session" | sha256sum | awk '{print $1}')"
else
  id="$(printf '%s\0%s\0%s\0%s' "$surface" "$kind" "$supersedes" "$body" | sha256sum | awk '{print $1}')"
fi
[ -e "$Q/$id.json" ] || [ -e "$P/$id.json" ] || python3 - "$Q/$id.json.tmp" "$surface" "$kind" "$body" "$id" "$supersedes" "$session" <<'PY'
import json,sys,os,datetime
tmp,surface,kind,body,eid,supersedes,session=sys.argv[1:]
obj={"version":2,"id":eid,"surface":surface,"kind":kind,"text":body,"createdAt":datetime.datetime.now(datetime.timezone.utc).isoformat()}
if supersedes: obj["supersedes"]=supersedes
if session: obj["sessionId"]=session
with open(tmp,"x") as f: json.dump(obj,f,ensure_ascii=False,separators=(",",":"))
os.chmod(tmp,0o600); os.replace(tmp,tmp[:-4])
PY
# Primary path: transactionally ingest now so the new revision is immediately visible.
# Materialization is best-effort here; the periodic compactor remains reconciliation/recovery.
R="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -e "$Q/$id.json" ]; then
  python3 "$R/context-store.py" ingest-file "$Q/$id.json" >/dev/null
fi
"$R/context-compact.sh" >/dev/null 2>&1 || true
printf '%s\n' "$id"
