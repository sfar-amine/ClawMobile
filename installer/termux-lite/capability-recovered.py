#!/data/data/com.termux/files/usr/bin/python
import json,sys,time
from pathlib import Path
if len(sys.argv)!=2 or not sys.argv[1].strip(): raise SystemExit("usage: capability-recovered.py <capability>")
cap=sys.argv[1].strip(); home=Path.home(); base=home/".openclaw"/"continuations"; resumed=[]
for p in sorted(base.glob("*-runs.json")) if base.exists() else []:
 try:d=json.loads(p.read_text())
 except Exception:continue
 changed=False
 for rid,row in d.items():
  if row.get("state")=="blocked" and row.get("blocked_by")==cap:
   row.update(state="resuming",blocked_by=None,recovered_capability=cap,updated_at=int(time.time()));resumed.append({"run_id":rid,"ledger":p.name,"target":row.get("target"),"intent":row.get("intent")});changed=True
 if changed:p.write_text(json.dumps(d,indent=2,sort_keys=True)+"\n")
out=home/".openclaw"/"continuations"/"resume-queue.jsonl";out.parent.mkdir(parents=True,exist_ok=True)
if resumed:
 with out.open("a") as f:
  for row in resumed:f.write(json.dumps({"event":"capability_recovered","capability":cap,"ts":int(time.time()),**row},sort_keys=True)+"\n")
print(json.dumps({"capability":cap,"resumed":resumed}))
