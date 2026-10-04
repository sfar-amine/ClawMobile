#!/data/data/com.termux/files/usr/bin/python3
import json,sqlite3,subprocess,sys,time
from pathlib import Path
HOME=Path.home(); DB=HOME/'.openclaw/incidents/orchestrator.db'; BASE=HOME/'.openclaw/continuations'; LINKS=BASE/'incident-links.json'; EVENTS=BASE/'incident-events.jsonl'
def load_links():
 try:return json.loads(LINKS.read_text())
 except Exception:return {}
def save_links(x): BASE.mkdir(parents=True,exist_ok=True);LINKS.write_text(json.dumps(x,indent=2,sort_keys=True)+'\n')
def link(i,cap,run='',ledger=''):
 x=load_links();x[i]={'affected_capability':cap,'run_id':run or None,'ledger':ledger or None,'linked_at':int(time.time())};save_links(x);return x[i]
def inherit(old_i,new_i):
 x=load_links();prior=x.get(old_i)
 if not prior:return {}
 current=dict(prior);current.pop('last_reconciled_state',None);current['linked_at']=int(time.time());current['inherited_from']=old_i
 x[new_i]=current;save_links(x);return current
def emit(i,state,component='',scope='',reason=''):
 x=load_links();meta=x.get(i,{})
 ev={'incident_id':i,'component':component,'scope':scope,'state':state,'affected_capability':meta.get('affected_capability'),'run_id':meta.get('run_id'),'ledger':meta.get('ledger'),'reason':reason,'ts':int(time.time())}
 BASE.mkdir(parents=True,exist_ok=True)
 with EVENTS.open('a') as f:f.write(json.dumps(ev,sort_keys=True)+'\n')
 if state=='recovered' and ev['affected_capability']:
  subprocess.run([str(Path(__file__).with_name('capability-recovered.py')),ev['affected_capability']],check=False,stdout=subprocess.DEVNULL)
 meta2=load_links();
 if i in meta2: meta2[i]['last_reconciled_state']=state;save_links(meta2)
 return ev
def reconcile():
 if not DB.exists():return {'checked':0,'emitted':0}
 c=sqlite3.connect(DB);c.row_factory=sqlite3.Row;links=load_links();n=0
 for i,m in links.items():
  r=c.execute('select id,component,scope,state from incidents where id=?',(i,)).fetchone()
  if not r:continue
  marker=m.get('last_reconciled_state')
  if r['state']!=marker:
   emit(i,r['state'],r['component'],r['scope'],'periodic reconciliation')
   links=load_links();links[i]['last_reconciled_state']=r['state'];n+=1
 save_links(links);c.close();return {'checked':len(links),'emitted':n}
if __name__=='__main__':
 if len(sys.argv)<2:raise SystemExit('usage: incident-continuation.py link|inherit|emit|reconcile ...')
 if sys.argv[1]=='link': print(json.dumps(link(*sys.argv[2:6])))
 elif sys.argv[1]=='inherit': print(json.dumps(inherit(*sys.argv[2:4])))
 elif sys.argv[1]=='emit': print(json.dumps(emit(*sys.argv[2:7])))
 elif sys.argv[1]=='reconcile': print(json.dumps(reconcile()))
