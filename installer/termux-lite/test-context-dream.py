#!/data/data/com.termux/files/usr/bin/python3
import json,os,pathlib,shutil,sqlite3,subprocess,tempfile
SRC=pathlib.Path.home()/'ClawMobile/installer/termux-lite'; tmp=pathlib.Path(tempfile.mkdtemp(prefix='dream-test.')); home=tmp/'home'; home.mkdir(); root=home/'.openclaw/context-sync'; hy=home/'.openclaw/workspace/context/HYBRID_CONTEXT.md'; hy.parent.mkdir(parents=True); hy.write_text('# dream\n')
env=os.environ.copy(); env.update(HOME=str(home),SAMANTHA_CONTEXT_ROOT=str(root),SAMANTHA_HYBRID_PATH=str(hy))
def run(n,*a): return subprocess.run([str(SRC/n),*a],env=env,text=True,capture_output=True,check=True).stdout.strip()
a=run('context-event.sh','chat','learning','DREAM duplicate fact'); b=run('context-event.sh','work','learning','DREAM duplicate fact')
old=run('context-event.sh','chat','decision','DREAM old fact'); new=run('context-event.sh','chat','decision','--supersedes',old,'DREAM new fact')
before=sqlite3.connect(root/'memory.db').execute('select count(*) from events').fetchone()[0]
r1=json.loads(run('context-dream.sh')); r2=json.loads(run('context-dream.sh'))
con=sqlite3.connect(root/'memory.db'); after=con.execute('select count(*) from events').fetchone()[0]; actions=[x[0] for x in con.execute('select action from dream_proposals order by action')]
assert before==after==4; assert actions==['confirm_supersession','consolidate_duplicate'],actions; assert r1['newProposals']==2; assert r2['newProposals']==0
print('PASS D01 shadow proposals immutable + idempotent'); print('RESULT 1/1 PASS'); shutil.rmtree(tmp,ignore_errors=True)
