#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
D="${SAMANTHA_CONTEXT_ROOT:-$HOME/.openclaw/context-sync}"; DB="$D/memory.db"
[ "$#" -ge 1 ] || { echo "usage: $0 <query> [limit] [--history]" >&2; exit 64; }
q="$1"; n="${2:-12}"; mode="${3:-current}"
python3 - "$DB" "$q" "$n" "$mode" <<'PY'
import json,re,sqlite3,sys
db,q,n,mode=sys.argv[1],sys.argv[2],max(1,min(int(sys.argv[3]),50)),sys.argv[4]
con=sqlite3.connect(db)
cols='id,revision,surface,kind,text,created_at,supersedes'
refs=[]
for raw in re.findall(r'AMINE-REQ-(\d+)',q,re.I):
    rev=int(raw)
    if rev not in refs:
        refs.append(rev)
if refs:
    rows=[dict(zip(('id','revision','surface','kind','text','createdAt','supersedes'),r))
          for r in con.execute(f'select {cols} from events order by revision asc').fetchall()]
    by_rev={int(r['revision']):r for r in rows}
    children={}
    for row in rows:
        if row['supersedes']:
            children.setdefault(row['supersedes'],[]).append(row)
    out=[]
    for rev in refs[:20]:
        ref=f'AMINE-REQ-{rev}'
        opening=by_rev.get(rev)
        if opening is None:
            out.append({'reference':ref,'found':False,'state':'missing'})
            continue
        chain=[opening]
        seen={opening['id']}
        queue=[opening['id']]
        while queue:
            parent=queue.pop(0)
            for child in children.get(parent,[]):
                if child['id'] in seen:
                    continue
                seen.add(child['id']); chain.append(child); queue.append(child['id'])
        chain.sort(key=lambda r:int(r['revision']))
        current=chain[-1]
        out.append({
            'reference':ref,
            'found':True,
            'state':'resolved' if current['kind']=='completed_action' else 'open',
            'opening':opening,
            'current':current,
            'chain':chain,
        })
    print(json.dumps(out,ensure_ascii=False,indent=2))
    raise SystemExit(0)
terms=[x for x in re.findall(r'[\w-]+',q.lower(),re.UNICODE) if len(x)>1]
rows=con.execute(f'select {cols} from events order by created_at desc limit 5000').fetchall()
sup={r[6] for r in rows if r[6]}
if mode!='--history': rows=[r for r in rows if r[0] not in sup]
def score(r):
    t=(r[2]+' '+r[3]+' '+r[4]).lower()
    return sum(3 if x in r[4].lower() else 1 for x in terms if x in t)
ranked=sorted((r for r in rows if not terms or score(r)>0),key=lambda r:(score(r),r[5]),reverse=True)[:n]
print(json.dumps([
    dict(id=r[0],revision=r[1],surface=r[2],kind=r[3],text=r[4],createdAt=r[5],supersedes=r[6])
    for r in ranked
],ensure_ascii=False,indent=2))
PY
