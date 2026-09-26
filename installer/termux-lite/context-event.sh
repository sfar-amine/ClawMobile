#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
D="$HOME/.openclaw/context-sync"; Q="$D/pending"; P="$D/processed"; S="$D/state"
mkdir -p "$Q" "$P" "$S"; chmod 700 "$D" "$Q" "$P" "$S"
usage(){ echo "usage: $0 <chat|work|voice|openclaw> <decision|learning|open_thread|completed_action|constraint|checkpoint> <text>"; exit 64; }
[ "$#" -ge 3 ] || usage
surface="$1"; kind="$2"; shift 2; body="$*"
case "$surface" in chat|work|voice|openclaw) ;; *) usage;; esac
case "$kind" in decision|learning|open_thread|completed_action|constraint|checkpoint) ;; *) usage;; esac
[ -n "$body" ] || usage
# Fail closed on common secret-like payloads; bridge events must be compact semantic facts, never transcripts.
if printf '%s' "$body" | grep -Eqi '(password|passwd|otp|cvv|cvc|authorization:[[:space:]]*bearer|api[_ -]?key|cookie:|-----BEGIN .*PRIVATE KEY-----)'; then
  echo "refusing secret-like context payload" >&2; exit 65
fi
id="$(printf '%s\0%s\0%s' "$surface" "$kind" "$body" | sha256sum | awk '{print $1}')"
[ -e "$Q/$id.json" ] || [ -e "$P/$id.json" ] || python3 - "$Q/$id.json.tmp" "$surface" "$kind" "$body" "$id" <<'PY'
import json,sys,os,datetime
tmp,surface,kind,body,eid=sys.argv[1:]
obj={"version":1,"id":eid,"surface":surface,"kind":kind,"text":body,"createdAt":datetime.datetime.now(datetime.timezone.utc).isoformat()}
with open(tmp,"x") as f: json.dump(obj,f,ensure_ascii=False,separators=(",",":"))
os.chmod(tmp,0o600); os.replace(tmp,tmp[:-4])
PY
printf '%s\n' "$id"
