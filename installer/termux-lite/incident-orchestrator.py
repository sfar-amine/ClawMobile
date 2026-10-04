#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import argparse, hashlib, json, sqlite3, time, subprocess, sys
from pathlib import Path
DEFAULT_DB=Path.home()/".openclaw"/"incidents"/"orchestrator.db"
DB=DEFAULT_DB
TERMINAL={"recovered","failed"}
TRANSITIONS={
 "detected":{"deterministic_recovery","diagnosing","verifying","human_required","failed"},
 "deterministic_recovery":{"diagnosing","verifying","human_required","failed"},
 "diagnosing":{"planning","verifying","waiting_model","waiting_validation","human_required","failed"},
 "planning":{"diagnosing","repairing","verifying","waiting_model","waiting_validation","human_required","failed"},
 "repairing":{"verifying","rolling_back","diagnosing","waiting_model","waiting_validation","human_required","failed"},
 "waiting_model":{"diagnosing","planning","verifying","failed"},
 "waiting_validation":{"planning","verifying","failed"},
 "rolling_back":{"diagnosing","verifying","failed"},
 "verifying":{"recovered","diagnosing","human_required","failed"},
 "human_required":{"diagnosing","verifying","recovered","failed"},
}
def connect():
 DB.parent.mkdir(parents=True,exist_ok=True);c=sqlite3.connect(DB,timeout=5.0);c.row_factory=sqlite3.Row;c.execute("PRAGMA busy_timeout=5000")
 c.executescript("""CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY,component TEXT,scope TEXT,state TEXT,created REAL,updated REAL,human_boundary INTEGER DEFAULT 0,human_reason TEXT,summary TEXT);
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,incident_id TEXT,ts REAL,source TEXT,kind TEXT,payload TEXT);
 CREATE INDEX IF NOT EXISTS idx_events_incident ON events(incident_id,seq);""")
 cols={row[1] for row in c.execute("PRAGMA table_info(incidents)")}
 if "next_retry" not in cols: c.execute("ALTER TABLE incidents ADD COLUMN next_retry REAL NOT NULL DEFAULT 0");c.commit()
 return c
def iid(component,scope): return hashlib.sha256(f"{component}:{scope}".encode()).hexdigest()[:20]
def emit(c,i,source,kind,payload):
 c.execute("INSERT INTO events(incident_id,ts,source,kind,payload) VALUES(?,?,?,?,?)",(i,time.time(),source,kind,json.dumps(payload,ensure_ascii=False,sort_keys=True)))
def run_learning_gate(i,out,state,reason):
 if DB!=DEFAULT_DB: return {"state":"skipped_noncanonical_db"}
 helper=Path(__file__).with_name("learning-gate-close.sh")
 cmd=[str(helper),"--source","incident","--closure-id",i,"--component",out["component"],"--status",state,"--summary",out.get("summary") or "","--incident-id",i]
 if state=="recovered" and reason: cmd.extend(["--final-fix",reason])
 try:
  p=subprocess.run(cmd,text=True,capture_output=True,timeout=15)
  if p.returncode!=0: return {"state":"failed","error":(p.stderr or "learning_gate_failed")[:300]}
  receipt=json.loads(p.stdout)
  return {"state":"ok","receipt_id":receipt.get("receipt_id",""),"capability_id":receipt.get("capability_id",""),"confidence":receipt.get("confidence","")}
 except Exception as exc: return {"state":"failed","error":str(exc)[:300]}
def open_incident(component,scope,source,summary):
 c=connect();now=time.time();c.execute("BEGIN IMMEDIATE")
 row=c.execute("SELECT * FROM incidents WHERE component=? AND scope=? ORDER BY created DESC LIMIT 1",(component,scope)).fetchone()
 if row and row["state"] not in TERMINAL:
  i=row["id"]
 else:
  i=iid(component,scope) if row is None else hashlib.sha256(f"{component}:{scope}:{time.time_ns()}".encode()).hexdigest()[:20]
  c.execute("INSERT INTO incidents(id,component,scope,state,created,updated,summary) VALUES(?,?,?,?,?,?,?)",(i,component,scope,"detected",now,now,summary))
 emit(c,i,source,"observed",{"summary":summary});c.commit();row=dict(c.execute("SELECT * FROM incidents WHERE id=?",(i,)).fetchone());c.close();return row
def transition(i,to,source,reason="",human_boundary=False,retry_after_s=60):
 c=connect()
 try:
  c.execute("BEGIN IMMEDIATE");row=c.execute("SELECT * FROM incidents WHERE id=?",(i,)).fetchone()
  if not row: raise SystemExit("unknown incident")
  fr=row["state"]
  if fr in TERMINAL and fr!=to: raise SystemExit(f"terminal incident: {fr}")
  if to!=fr and to not in TRANSITIONS.get(fr,set()): raise SystemExit(f"invalid transition {fr}->{to}")
  if to=="human_required" and not human_boundary: raise SystemExit("human_required requires verified human boundary")
  due=time.time()+max(30,min(int(retry_after_s),3600)) if to=="waiting_model" else 0
  c.execute("UPDATE incidents SET state=?,updated=?,human_boundary=?,human_reason=?,next_retry=? WHERE id=?",(to,time.time(),1 if human_boundary else row["human_boundary"],reason if human_boundary else row["human_reason"],due,i))
  emit(c,i,source,"transition",{"from":fr,"to":to,"reason":reason,"human_boundary":bool(human_boundary)})
  c.commit();out=dict(c.execute("SELECT * FROM incidents WHERE id=?",(i,)).fetchone())
 finally:
  c.close()
 if to in {"recovered","failed","human_required"}:
  helper=Path(__file__).with_name("incident-continuation.py")
  subprocess.run([sys.executable,str(helper),"emit",i,to,out["component"],out["scope"],reason],check=False,stdout=subprocess.DEVNULL)
 if to in TERMINAL:
  gate=run_learning_gate(i,out,to,reason)
  gc=connect();emit(gc,i,"learning-gate","learning_gate",gate);gc.commit();gc.close()
  out["learning_gate"]=gate
 return out

def observe(i,source,kind,payload):
 c=connect();emit(c,i,source,kind,payload);c.execute("UPDATE incidents SET updated=? WHERE id=?",(time.time(),i));c.commit();c.close()

def recover_incident(component,scope,source,reason="verified service recovery"):
 c=connect();row=c.execute("SELECT * FROM incidents WHERE component=? AND scope=? ORDER BY created DESC LIMIT 1",(component,scope)).fetchone();c.close()
 if not row: return None
 i=row["id"]
 if row["state"]=="recovered": return dict(row)
 if row["state"]=="failed":
  prior=i
  reopened=open_incident(component,scope,source,f"verified recovery after failed incident: {reason}")
  i=reopened["id"]
  if DB==DEFAULT_DB:
   helper=Path(__file__).with_name("incident-continuation.py")
   subprocess.run([sys.executable,str(helper),"inherit",prior,i],check=False,stdout=subprocess.DEVNULL)
  observe(i,source,"recovery_after_failed",{"prior_incident_id":prior,"reason":reason})
 if row["state"]!="verifying" or i!=row["id"]: transition(i,"verifying",source,reason)
 return transition(i,"recovered",source,reason)

def show(i):
 c=connect();row=c.execute("SELECT * FROM incidents WHERE id=?",(i,)).fetchone();ev=[dict(x) for x in c.execute("SELECT * FROM events WHERE incident_id=? ORDER BY seq",(i,))];c.close();return {"incident":dict(row) if row else None,"events":ev}
def main():
 p=argparse.ArgumentParser();s=p.add_subparsers(dest="cmd",required=True)
 o=s.add_parser("open");o.add_argument("component");o.add_argument("scope");o.add_argument("--source",required=True);o.add_argument("--summary",default="")
 t=s.add_parser("transition");t.add_argument("id");t.add_argument("state");t.add_argument("--source",required=True);t.add_argument("--reason",default="");t.add_argument("--human-boundary",action="store_true");t.add_argument("--retry-after",type=int,default=60)
 e=s.add_parser("observe");e.add_argument("id");e.add_argument("kind");e.add_argument("--source",required=True);e.add_argument("--json",default="{}")
 r=s.add_parser("recover");r.add_argument("component");r.add_argument("scope");r.add_argument("--source",required=True);r.add_argument("--reason",default="verified service recovery")
 g=s.add_parser("show");g.add_argument("id")
 a=p.parse_args()
 if a.cmd=="open": out=open_incident(a.component,a.scope,a.source,a.summary)
 elif a.cmd=="transition": out=transition(a.id,a.state,a.source,a.reason,a.human_boundary,a.retry_after)
 elif a.cmd=="observe": observe(a.id,a.source,a.kind,json.loads(a.json));out=show(a.id)
 elif a.cmd=="recover": out=recover_incident(a.component,a.scope,a.source,a.reason)
 else: out=show(a.id)
 print(json.dumps(out,ensure_ascii=False,indent=2))
if __name__=="__main__": main()
