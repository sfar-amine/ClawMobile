#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
D="$HOME/.openclaw/context-sync"; Q="$D/pending"; P="$D/processed"; H="$HOME/.openclaw/workspace/context/HYBRID_CONTEXT.md"; L="$D/context-compact.log"
mkdir -p "$Q" "$P"; exec 9>"$D/context-compact.lock"; flock -n 9 || exit 0
files=("$Q"/*.json); [ -e "${files[0]}" ] || exit 0
tmp="$D/merge.$$"
python3 - "$H" "${files[@]}" >"$tmp" <<'PY'
import json,sys,datetime
h=sys.argv[1]; paths=sys.argv[2:]
events=[]
for p in paths:
    try:
        with open(p) as f: events.append(json.load(f))
    except Exception: continue
if not events: raise SystemExit(0)
with open(h) as f: old=f.read()
seen=set()
lines=[]
for e in events:
    marker=f"<!-- context-event:{e['id']} -->"
    if marker in old or e["id"] in seen: continue
    seen.add(e["id"])
    text=" ".join(str(e["text"]).split())
    lines.append(f"- [{e['surface']}/{e['kind']}] {text} {marker}")
if not lines:
    print(old,end=""); raise SystemExit
stamp=datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %z")
section="\n## Cross-surface checkpoint events — "+stamp+"\n" + "\n".join(lines) + "\n"
print(old.rstrip()+section)
PY
if [ -s "$tmp" ]; then chmod 600 "$tmp"; mv "$tmp" "$H"; fi
for f in "${files[@]}"; do [ -e "$f" ] && mv "$f" "$P/"; done
date -Iseconds >"$D/state/last_compaction"
printf '%s event=compact result=ok count=%s\n' "$(date -Iseconds)" "${#files[@]}" >>"$L"
