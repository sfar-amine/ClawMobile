#!/data/data/com.termux/files/usr/bin/python3
import concurrent.futures,json,os,pathlib,shutil,sqlite3,subprocess,tempfile
SRC=pathlib.Path.home()/'ClawMobile/installer/termux-lite'
tmp=pathlib.Path(tempfile.mkdtemp(prefix='samantha-coherence.')); home=tmp/'home'; home.mkdir()
root=home/'.openclaw/context-sync'; hybrid=home/'.openclaw/workspace/context/HYBRID_CONTEXT.md'; hybrid.parent.mkdir(parents=True); hybrid.write_text('# Coherence\n')
env=os.environ.copy(); env.update(HOME=str(home),SAMANTHA_CONTEXT_ROOT=str(root),SAMANTHA_HYBRID_PATH=str(hybrid))
def run(n,*a,ok=(0,)):
 p=subprocess.run([str(SRC/n),*a],env=env,text=True,capture_output=True)
 if p.returncode not in ok: raise AssertionError(f'{n} rc={p.returncode} out={p.stdout} err={p.stderr}')
 return p.stdout.strip()
def ev(s,k,t): return run('context-event.sh',s,k,t)
tests=[]
def T(n,f):
 try:f();tests.append((n,'PASS',''))
 except Exception as e:tests.append((n,'FAIL',str(e)))
def c01():
 assert run('context-head.sh')=='0'
 a=ev('chat','decision','C01 alpha'); run('context-flush.sh'); assert run('context-head.sh')=='1'
 b=ev('work','learning','C01 beta'); run('context-flush.sh'); assert run('context-head.sh')=='2'
 d=json.loads(run('context-delta.sh','0')); assert [x['revision'] for x in d['events']]==[1,2] and d['toRevision']==2
T('C01 monotonic revision + ordered delta',c01)
def c02():
 h=int(run('context-head.sh')); ev('chat','decision','C02 duplicate'); run('context-flush.sh'); h1=int(run('context-head.sh'))
 ev('chat','decision','C02 duplicate'); run('context-flush.sh'); assert int(run('context-head.sh'))==h1==h+1
T('C02 duplicate does not allocate revision',c02)
def c03():
 h=int(run('context-head.sh')); d=json.loads(run('context-check.sh',str(h))); assert d['changed'] is False and d['events']==[]
T('C03 unchanged barrier is revision-only',c03)
def c04():
 h=int(run('context-head.sh'))
 for i in range(4): ev(('chat','work','voice','openclaw')[i],'checkpoint',f'C04 {i}')
 run('context-flush.sh'); d=json.loads(run('context-delta.sh',str(h))); assert len(d['events'])==4 and d['events'][0]['revision']==h+1
T('C04 cross-surface delta',c04)
def c05():
 h=int(run('context-head.sh')); out=json.loads(subprocess.run(['python3',str(SRC/'context-store.py'),'cursor-set','chat-A','chat',str(h)],env=env,text=True,capture_output=True,check=True).stdout)
 assert out['lastSeenRevision']==h
 got=json.loads(subprocess.run(['python3',str(SRC/'context-store.py'),'cursor-get','chat-A'],env=env,text=True,capture_output=True,check=True).stdout); assert got['lastSeenRevision']==h
T('C05 session cursor',c05)
def c06():
 h=int(run('context-head.sh')); p=subprocess.run(['python3',str(SRC/'context-store.py'),'cursor-set','bad','chat',str(h+100)],env=env,text=True,capture_output=True)
 assert p.returncode!=0
T('C06 cursor cannot advance beyond head',c06)
def c07():
 base=int(run('context-head.sh'))
 def one(i): return ev('chat','learning',f'C07 concurrent {i:03d}')
 with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:list(ex.map(one,range(80)))
 run('context-flush.sh'); con=sqlite3.connect(root/'memory.db'); rev=[r[0] for r in con.execute("select revision from events where text like 'C07 concurrent %' order by revision")]
 assert len(rev)==80 and len(set(rev))==80 and rev==list(range(base+1,base+81))
T('C07 concurrent events receive unique contiguous revisions',c07)
for n,s,e in tests: print(f'{s} {n}'+(f' :: {e}' if e else ''))
bad=[x for x in tests if x[1]=='FAIL']; print(f'RESULT {len(tests)-len(bad)}/{len(tests)} PASS')
shutil.rmtree(tmp,ignore_errors=True); raise SystemExit(1 if bad else 0)
