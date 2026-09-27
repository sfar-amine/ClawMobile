#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import argparse, hashlib, json, sqlite3, time
from pathlib import Path
DB=Path.home()/".openclaw"/"incidents"/"orchestrator.db"
TERMINAL={"recovered","human_required","failed"}
TRANSITIONS={
 "detected":{"deterministic_recovery","diagnosing","human_required","failed"},
 "deterministic_recovery":{"diagnosing","verifying","human_required","failed"},
 "diagnosing":{"planning","human_required","failed"},
 "planning":{"repairing","human_required","failed"},
 "repairing":{"verifying","rolling_back","diagnosing","human_required","failed"},
 "rolling_back":{"diagnosing","failed"},
 "verifying":{"recovered","diagnosing","human_required","failed"},
}
def connect():
 DB.parent.mkdir(parents=True,exist_ok=True);c=sqlite3.connect(DB);c.row_factory=sqlite3.Row
 c.executescript("""CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY,component TEXT,scope TEXT,state TEXT,created REAL,updated REAL,human_boundary INTEGER DEFAULT 0,human_reason TEXT,summary TEXT);
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,incident_id TEXT,ts REAL,source TEXT,kind TEXT,payload TEXT);
 CREATE INDEX IF NOT EXISTS idx_events_incident ON events(incident_id,seq);""");return c
def iid(component,scope): return hashlib.sha256(f"{component}:{scope}".encode()).hexdigest()[:20]
def emit(c,i,source,kind,payload):
 c.execute("INSERT INTO events(incident_id,ts,source,kind,payload) VALUES(?,?,?,?,?)",(i,time.time(),source,kind,json.dumps(payload,ensure_ascii=False,sort_keys=True)))
def open_incident(component,scope,source,summary):
 c=connect();i=iid(component,scope);now=time.time()
 c.execute("INSERT OR IGNORE INTO incidents(id,component,scope,state,created,updated,summary) VALUES(?,?,?,?,?,?,?)",(i,component,scope,"detected",now,now,summary))
 emit(c,i,source,"observed",{"summary":summary});c.commit();row=dict(c.execute("SELECT * FROM incidents WHERE id=?",(i,)).fetchone());c.close();return row
def transition(i,to,source,reason="",human_boundary=False):
 c=connect();row=c.execute("SELECT * FROM incidents WHERE id=?",(i,)).fetchone()
 if not row: raise SystemExit("unknown incident")
 fr=row["state"]
 if fr in TERMINAL and fr!=to: raise SystemExit(f"terminal incident: {fr}")
 if to!=fr and to not in TRANSITIONS.get(fr,set()): raise SystemExit(f"invalid transition {fr}->{to}")
 if to=="human_required" and not human_boundary: raise SystemExit("human_required requires verified human boundary")
 c.execute("UPDATE incidents SET state=?,updated=?,human_boundary=?,human_reason=? WHERE id=?",(to,time.time(),1 if human_boundary else row["human_boundary"],reason if human_boundary else row["human_reason"],i))
 emit(c,i,source,"transition",{"from":fr,"to":to,"reason":reason,"human_boundary":bool(human_boundary)});c.commit();out=dict(c.execute("SELECT * FROM incidents WHERE id=?",(i,)).fetchone());c.close();return out
def observe(i,source,kind,payload):
 c=connect();emit(c,i,source,kind,payload);c.execute("UPDATE incidents SET updated=? WHERE id=?",(time.time(),i));c.commit();c.close()
def show(i):
 c=connect();row=c.execute("SELECT * FROM incidents WHERE id=?",(i,)).fetchone();ev=[dict(x) for x in c.execute("SELECT * FROM events WHERE incident_id=? ORDER BY seq",(i,))];c.close();return {"incident":dict(row) if row else None,"events":ev}
def main():
 p=argparse.ArgumentParser();s=p.add_subparsers(dest="cmd",required=True)
 o=s.add_parser("open");o.add_argument("component");o.add_argument("scope");o.add_argument("--source",required=True);o.add_argument("--summary",default="")
 t=s.add_parser("transition");t.add_argument("id");t.add_argument("state");t.add_argument("--source",required=True);t.add_argument("--reason",default="");t.add_argument("--human-boundary",action="store_true")
 e=s.add_parser("observe");e.add_argument("id");e.add_argument("kind");e.add_argument("--source",required=True);e.add_argument("--json",default="{}")
 g=s.add_parser("show");g.add_argument("id")
 a=p.parse_args()
 if a.cmd=="open": out=open_incident(a.component,a.scope,a.source,a.summary)
 elif a.cmd=="transition": out=transition(a.id,a.state,a.source,a.reason,a.human_boundary)
 elif a.cmd=="observe": observe(a.id,a.source,a.kind,json.loads(a.json));out=show(a.id)
 else: out=show(a.id)
 print(json.dumps(out,ensure_ascii=False,indent=2))
if __name__=="__main__": main()
