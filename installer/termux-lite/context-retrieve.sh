#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
DB="$HOME/.openclaw/context-sync/memory.db"
[ "$#" -ge 1 ] || { echo "usage: $0 <query> [limit]" >&2; exit 64; }
python3 - "$DB" "$1" "${2:-12}" <<'PY'
import json,re,sqlite3,sys
db,q,n=sys.argv[1],sys.argv[2],max(1,min(int(sys.argv[3]),50)); con=sqlite3.connect(db)
terms=[x for x in re.findall(r'[\w-]+',q.lower(),re.UNICODE) if len(x)>1]
rows=con.execute('select id,surface,kind,text,created_at from events order by created_at desc limit 2000').fetchall()
def score(r):
 t=(r[1]+' '+r[2]+' '+r[3]).lower()
 return sum(3 if x in r[3].lower() else 1 for x in terms if x in t)
ranked=sorted((r for r in rows if not terms or score(r)>0),key=lambda r:(score(r),r[4]),reverse=True)[:n]
print(json.dumps([dict(id=r[0],surface=r[1],kind=r[2],text=r[3],createdAt=r[4]) for r in ranked],ensure_ascii=False,indent=2))
PY
