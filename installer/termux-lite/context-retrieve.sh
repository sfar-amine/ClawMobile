#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
D="${SAMANTHA_CONTEXT_ROOT:-$HOME/.openclaw/context-sync}"; DB="$D/memory.db"
[ "$#" -ge 1 ] || { echo "usage: $0 <query> [limit] [--history]" >&2; exit 64; }
q="$1"; n="${2:-12}"; mode="${3:-current}"
python3 - "$DB" "$q" "$n" "$mode" <<'PY'
import json,re,sqlite3,sys
db,q,n,mode=sys.argv[1],sys.argv[2],max(1,min(int(sys.argv[3]),50)),sys.argv[4]
con=sqlite3.connect(db); terms=[x for x in re.findall(r'[\w-]+',q.lower(),re.UNICODE) if len(x)>1]
rows=con.execute('select id,surface,kind,text,created_at,supersedes from events order by created_at desc limit 5000').fetchall()
sup={r[5] for r in rows if r[5]}
if mode!='--history': rows=[r for r in rows if r[0] not in sup]
def score(r):
 t=(r[1]+' '+r[2]+' '+r[3]).lower()
 return sum(3 if x in r[3].lower() else 1 for x in terms if x in t)
ranked=sorted((r for r in rows if not terms or score(r)>0),key=lambda r:(score(r),r[4]),reverse=True)[:n]
print(json.dumps([dict(id=r[0],surface=r[1],kind=r[2],text=r[3],createdAt=r[4],supersedes=r[5]) for r in ranked],ensure_ascii=False,indent=2))
PY
