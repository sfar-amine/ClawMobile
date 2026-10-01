#!/data/data/com.termux/files/usr/bin/python3
import concurrent.futures,json,os,pathlib,shutil,sqlite3,subprocess,tempfile,time
SRC=pathlib.Path(__file__).resolve().parent; tmp=pathlib.Path(tempfile.mkdtemp(prefix='samantha-integration.')); home=tmp/'home'; home.mkdir()
root=home/'.openclaw/context-sync'; hybrid=home/'.openclaw/workspace/context/HYBRID_CONTEXT.md'; hybrid.parent.mkdir(parents=True); hybrid.write_text('# Integration Hybrid\n')
env=os.environ.copy(); env.update(HOME=str(home),SAMANTHA_CONTEXT_ROOT=str(root),SAMANTHA_HYBRID_PATH=str(hybrid))
def run(name,*args,ok=(0,)):
 p=subprocess.run([str(SRC/name),*args],env=env,text=True,capture_output=True)
 if p.returncode not in ok: raise RuntimeError(f'{name} rc={p.returncode} {p.stderr}')
 return p
def ev(s,k,t,*extra): return run('context-event.sh',s,k,*extra,t).stdout.strip()
results=[]
def test(name,fn):
 try: fn(); results.append((name,'PASS',''))
 except Exception as e: results.append((name,'FAIL',str(e)))
def i01():
 eid=ev('chat','decision','I01 ORION deliveries Thursday'); run('context-flush.sh')
 assert eid in hybrid.read_text(); assert any(x['id']==eid for x in json.loads(run('context-retrieve.sh','ORION Thursday','5').stdout))
test('I01 Chat -> durable store -> checkpoint -> retrieval',i01)
def i02():
 eid=ev('openclaw','learning','I02 VEGA three controls before deployment'); run('context-flush.sh')
 assert any(x['id']==eid for x in json.loads(run('context-retrieve.sh','VEGA controls','5').stdout))
test('I02 OpenClaw -> common memory',i02)
def i03():
 a=ev('work','constraint','I03 NOVA Work fact W-19'); b=ev('voice','checkpoint','I03 NOVA Voice fact V-23'); run('context-flush.sh')
 got=json.loads(run('context-retrieve.sh','NOVA','10').stdout); ids={x['id'] for x in got}; assert {a,b}<=ids
test('I03 Work + Voice bidirectional common store',i03)
def i04():
 old=ev('chat','decision','I04 ALPHA old ORANGE-47'); run('context-flush.sh'); new=ev('openclaw','decision','I04 ALPHA current BLUE-92','--supersedes',old); run('context-flush.sh')
 cur=json.loads(run('context-retrieve.sh','I04 ALPHA','10').stdout); assert new in {x['id'] for x in cur} and old not in {x['id'] for x in cur}
test('I04 cross-surface supersession',i04)
def i05():
    opening=ev('chat','open_thread','I05 owner validation a valider')
    con=sqlite3.connect(root/'memory.db'); rev=con.execute('select revision from events where id=?',(opening,)).fetchone()[0]; con.close()
    done=ev('chat','completed_action','I05 owner validation approved','--supersedes',opening)
    got=json.loads(run('context-retrieve.sh',f'AMINE-REQ-{rev} ok','10').stdout)
    assert len(got)==1 and got[0]['found'] and got[0]['state']=='resolved'
    assert got[0]['opening']['id']==opening and got[0]['current']['id']==done
    assert [x['id'] for x in got[0]['chain']]==[opening,done]
test('I05 AMINE-REQ direct resolution follows supersedes',i05)
def i06():
    a=ev('chat','open_thread','I06 first owner action'); b=ev('chat','open_thread','I06 second owner action')
    con=sqlite3.connect(root/'memory.db'); ra=con.execute('select revision from events where id=?',(a,)).fetchone()[0]; rb=con.execute('select revision from events where id=?',(b,)).fetchone()[0]; con.close()
    got=json.loads(run('context-retrieve.sh',f'AMINE-REQ-{ra} ok AMINE-REQ-{rb} fait','10').stdout)
    assert [x['reference'] for x in got]==[f'AMINE-REQ-{ra}',f'AMINE-REQ-{rb}']
    assert all(x['state']=='open' for x in got)
test('I06 multiple AMINE-REQ references resolve in one turn',i06)
def r01():
 eid=ev('chat','decision','R01 event-driven durable processing'); assert (root/'processed'/f'{eid}.json').exists(); assert int(run('context-head.sh').stdout.strip())>0
test('R01 event becomes durable immediately',r01)
def r02():
 def one(i): return ev(('chat','work','voice','openclaw')[i%4],'learning',f'R02 concurrent event {i:03d}')
 with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex: ids=list(ex.map(one,range(120)))
 assert len(set(ids))==120; run('context-flush.sh'); con=sqlite3.connect(root/'memory.db'); assert con.execute("select count(*) from events where text like 'R02 concurrent event %'").fetchone()[0]==120
test('R02 120 concurrent cross-surface writes',r02)
def r03():
 size=hybrid.stat().st_size
 assert size<30000, size
 assert hybrid.read_text().count('context-event:')<=64
test('R03 bounded checkpoint under load',r03)
def r04():
 before=json.loads(run('context-retrieve.sh','ORION Thursday','5').stdout); hybrid.unlink(); run('context-compact.sh'); after=json.loads(run('context-retrieve.sh','ORION Thursday','5').stdout)
 assert before and after and 'ORION' in hybrid.read_text()
test('R04 checkpoint rebuild from durable store',r04)
def r05():
 bad=root/'pending'/'corrupt.json'; bad.write_text('not-json'); p=run('context-compact.sh',ok=(65,)); assert bad.exists(); bad.unlink(); run('context-flush.sh')
test('R05 poison event retained, recovery after removal',r05)
for n,s,e in results: print(f'{s} {n}'+(f' :: {e}' if e else ''))
failed=[x for x in results if x[1]=='FAIL']; print(f'RESULT {len(results)-len(failed)}/{len(results)} PASS')
shutil.rmtree(tmp,ignore_errors=True); raise SystemExit(1 if failed else 0)
