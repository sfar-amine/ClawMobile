#!/data/data/com.termux/files/usr/bin/python3
import json,os,pathlib,shutil,sqlite3,subprocess,tempfile
SRC=pathlib.Path.home()/'ClawMobile/installer/termux-lite'
tmp=pathlib.Path(tempfile.mkdtemp(prefix='samantha-memory-test.')); home=tmp/'home'; home.mkdir(); root=home/'.openclaw/context-sync'; hybrid=home/'.openclaw/workspace/context/HYBRID_CONTEXT.md'; hybrid.parent.mkdir(parents=True); hybrid.write_text('# Test Hybrid\n')
env=os.environ.copy(); env.update(HOME=str(home),SAMANTHA_CONTEXT_ROOT=str(root),SAMANTHA_HYBRID_PATH=str(hybrid))
def run(name,*args,ok=(0,)):
 p=subprocess.run([str(SRC/name),*args],env=env,text=True,capture_output=True)
 if p.returncode not in ok: raise AssertionError(f'{name} rc={p.returncode} out={p.stdout} err={p.stderr}')
 return p
tests=[]
def T(name,fn):
 try: fn(); tests.append((name,'PASS',''))
 except Exception as e: tests.append((name,'FAIL',str(e)))
def event(surface='chat',kind='decision',text='TEST-ALPHA règle ORANGE-47',extra=()):
 return run('context-event.sh',surface,kind,*extra,text).stdout.strip()
T('U01 valid event creates pending',lambda: (lambda i: (_ for _ in ()).throw(AssertionError()) if not (root/'pending'/f'{i}.json').exists() else None)(event()))
T('U02 duplicate is idempotent',lambda: (_ for _ in ()).throw(AssertionError()) if event()=='' or len(list((root/'pending').glob('*.json')))!=1 else None)
def u03():
 for s in ('work','voice','openclaw'): event(s,'learning',f'unit surface {s}')
 assert len(list((root/'pending').glob('*.json'))) == 4
T('U03 all surfaces accepted',u03)
T('U04 invalid surface rejected',lambda: run('context-event.sh','bad','decision','x',ok=(64,)))
T('U05 secret OTP rejected',lambda: run('context-event.sh','chat','decision','OTP 123456',ok=(65,)))
T('U05b payment-card-like rejected',lambda: run('context-event.sh','chat','decision','card 4168437700288503',ok=(65,)))
def u06():
 run('context-compact.sh'); assert len(list((root/'pending').glob('*.json')))==0; assert len(list((root/'processed').glob('*.json')))>=4
T('U06 compact drains valid pending',u06)
def u07():
 before=sqlite3.connect(root/'memory.db').execute('select count(*) from events').fetchone()[0]; run('context-compact.sh'); after=sqlite3.connect(root/'memory.db').execute('select count(*) from events').fetchone()[0]; assert before==after
T('U07 recompact no duplication',u07)
def u08():
 con=sqlite3.connect(root/'memory.db'); assert {r[0] for r in con.execute('select distinct surface from events')} >= {'chat','work','voice','openclaw'}
T('U08 multisurface indexed',u08)
def u09():
 for i in range(30): event('chat','decision',f'BOUND-{i:02d} durable decision')
 run('context-compact.sh'); txt=hybrid.read_text(); assert txt.count('[chat/decision]')<=18
T('U09 bounded decision view',u09)
def u10():
 out=json.loads(run('context-retrieve.sh','BOUND-29','5').stdout); assert out and 'BOUND-29' in out[0]['text']
T('U10 retrieval hit',u10)
def u11(): assert json.loads(run('context-retrieve.sh','NO_SUCH_ZZZ_999','5').stdout)==[]
T('U11 retrieval miss',u11)
def u12(): assert 'CONTEXT_FLUSH_OK' in run('context-flush.sh').stdout
T('U12 flush success',u12)
def u13():
 bad=root/'pending'/'bad.json'; bad.write_text('{broken'); p=run('context-compact.sh',ok=(65,)); assert bad.exists(); bad.unlink()
T('U13 malformed retained and fails',u13)
def u14():
 old=event('chat','decision','SUPERTEST old value')
 run('context-flush.sh'); new=event('chat','decision','SUPERTEST new value',('--supersedes',old)); run('context-flush.sh')
 cur=json.loads(run('context-retrieve.sh','SUPERTEST','10').stdout); hist=json.loads(run('context-retrieve.sh','SUPERTEST','10','--history').stdout)
 assert all(x['id']!=old for x in cur) and any(x['id']==old for x in hist) and any(x['id']==new for x in cur)
T('U14 supersession current/history',u14)
def u15():
 txt=hybrid.read_text(); hybrid.unlink(); run('context-compact.sh'); assert hybrid.exists() and 'BOUND-29' in hybrid.read_text()
T('U15 checkpoint reconstructible',u15)
for n,s,e in tests: print(f'{s} {n}'+(f' :: {e}' if e else ''))
failed=[x for x in tests if x[1]!='PASS']; print(f'RESULT {len(tests)-len(failed)}/{len(tests)} PASS')
shutil.rmtree(tmp,ignore_errors=True)
raise SystemExit(1 if failed else 0)
