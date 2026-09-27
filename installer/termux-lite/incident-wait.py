#!/data/data/com.termux/files/usr/bin/python3
import argparse,json,sqlite3,time
from pathlib import Path
DB=Path.home()/'.openclaw/incidents/orchestrator.db'
p=argparse.ArgumentParser();p.add_argument('incident_id');p.add_argument('--budget',type=int,default=45);p.add_argument('--interval',type=float,default=5);a=p.parse_args()
end=time.monotonic()+max(0,a.budget); last=None
while True:
 c=sqlite3.connect(DB);c.row_factory=sqlite3.Row;r=c.execute('select * from incidents where id=?',(a.incident_id,)).fetchone();c.close()
 if not r:raise SystemExit('unknown incident')
 row=dict(r);state=row['state']
 if state!=last: print(json.dumps({'incident_id':a.incident_id,'state':state,'updated':row['updated']}),flush=True);last=state
 if state in ('recovered','failed','human_required'):raise SystemExit(0)
 if time.monotonic()>=end:
  print(json.dumps({'incident_id':a.incident_id,'state':state,'handoff':'persistent'}),flush=True);raise SystemExit(75)
 time.sleep(max(.5,a.interval))
