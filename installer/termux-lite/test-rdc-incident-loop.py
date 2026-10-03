#!/data/data/com.termux/files/usr/bin/python3
"""Execute the real worker in an isolated HOME with fixed provider/repair doubles."""
import json, os, shutil, signal, sqlite3, subprocess, tempfile, time, unittest, sys
from pathlib import Path
ROOT=Path(__file__).parent

class IncidentLoop(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.home=Path(self.tmp.name);self.root=self.home/'runtime';self.root.mkdir()
        for name in ['incident-orchestrator.py','incident-orchestrator-worker.sh']:
            shutil.copy2(ROOT/name,self.root/name)
        self.write('engineering-repair.sh','#!/bin/sh\nexit 1\n')
        self.write('incident-continuation.py','#!/usr/bin/env python3\n')
        self.write('learning-gate-close.sh','#!/bin/sh\necho "{}"\n')
        self.write('remote-desktop-control.py','''#!/usr/bin/env python3
import json,sys,pathlib
p=pathlib.Path.home()/'repair-count'
if sys.argv[1]=='repair': p.write_text(str(int(p.read_text() if p.exists() else '0')+1))
print(json.dumps({'state':'healthy' if p.exists() else 'degraded','proof':'isolated fixture'}))
sys.exit(0 if sys.argv[1]!='health' or p.exists() else 1)
''')
        self.write('autonomous-engineering-shadow.sh','''#!/usr/bin/env python3
import json,sys,sqlite3,pathlib,subprocess
h=pathlib.Path.home();i=sys.argv[3];c=sqlite3.connect(h/'.openclaw/incidents/orchestrator.db')
n=c.execute("select count(*) from events where incident_id=? and kind='diagnostics_collected'",(i,)).fetchone()[0]
action='diagnostics.collect_more' if n==0 else 'runtime.managed_repair'
r={'status':'success','model_verified':True,'actual_model':'fixture','diagnosis':{'recommended_action_id':action}}
p=h/'.openclaw/autonomous-engineering/shadow';p.mkdir(parents=True,exist_ok=True);(p/(i+'.json')).write_text(json.dumps(r))
with (h/'model-rounds').open('a') as f:f.write(str(n)+'\\n')
subprocess.run([str(pathlib.Path(__file__).with_name('incident-orchestrator.py')),'observe',i,'diagnosis','--source','test-double','--json',json.dumps({'recommended_action_id':action})],stdout=subprocess.DEVNULL,check=True)
''')
        self.env=dict(os.environ,HOME=str(self.home),CLAW_RUNTIME_ROOT=str(self.root))
        (self.home/'.openclaw/health').mkdir(parents=True)
        self.orch=self.root/'incident-orchestrator.py'
    def write(self,name,text):
        # Native Termux shebangs are retained on device and adapted only for host tests.
        p=self.root/name;text=text.replace('#!/usr/bin/env python3', '#!'+sys.executable).replace('#!/bin/sh', '#!'+shutil.which('sh'));p.write_text(text);p.chmod(0o755)
    def call(self,*args):
        return json.loads(subprocess.check_output(['python3',str(self.orch),*args],env=self.env,text=True))
    def start(self):
        # Portable fixture shebang for copied orchestrator.
        text=self.orch.read_text();self.orch.write_text('#!'+sys.executable+'\n'+'\n'.join(text.splitlines()[1:])+'\n');self.orch.chmod(0o755)
        self.proc=subprocess.Popen(['bash',str(self.root/'incident-orchestrator-worker.sh')],env=self.env,start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        def cleanup():
            try:os.killpg(self.proc.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            self.proc.wait(timeout=5)
        self.addCleanup(cleanup)
    def terminal(self,i):
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            d=self.call('show',i)
            if d['incident']['state'] in ('recovered','failed'):return d
            time.sleep(.1)
        self.fail('worker did not reach bounded terminal state')
    def test_diagnostics_return_to_same_incident_then_verified_repair(self):
        i=self.call('open','remote_desktop','acceptance','--source','test','--summary','controlled fixture')['id'];self.start()
        d=self.terminal(i);self.assertEqual(d['incident']['state'],'recovered')
        self.assertEqual((self.home/'model-rounds').read_text().splitlines(),['0','1'])
        self.assertEqual((self.home/'repair-count').read_text(),'1')
        self.assertEqual(sum(x['kind']=='diagnostics_collected' for x in d['events']),1)
    def test_interrupted_effect_is_verified_without_replay(self):
        i=self.call('open','remote_desktop','acceptance','--source','test')['id']
        for state in ['diagnosing','planning','repairing']: self.call('transition',i,state,'--source','test')
        (self.home/'repair-count').write_text('1');self.start();d=self.terminal(i)
        self.assertEqual(d['incident']['state'],'recovered');self.assertEqual((self.home/'repair-count').read_text(),'1')
        self.assertFalse((self.home/'model-rounds').exists())
    def test_controller_launch_failure_is_not_waiting_for_model(self):
        shutil.copy2(ROOT/'engineering-incident-result.py',self.root/'engineering-incident-result.py')
        self.write('engineering-repair.sh','#!/bin/sh\n[ "$1" = supports ] && exit 0\necho SHOULD_NOT_RUN\n')
        bindir=self.home/'bin';bindir.mkdir();f=bindir/'timeout'
        f.write_text('#!'+shutil.which('sh')+'\nexit 125\n');f.chmod(0o755)
        self.env['PATH']=str(bindir)+os.pathsep+self.env['PATH']
        i=self.call('open','fixture-code','acceptance','--source','test')['id'];self.start()
        d=self.terminal(i);self.assertEqual(d['incident']['state'],'failed')
        transitions=[json.loads(x['payload']).get('to') for x in d['events'] if x['kind']=='transition']
        self.assertNotIn('waiting_model',transitions);self.assertFalse((self.home/'model-rounds').exists())
    def test_unverified_provider_cannot_authorize_repair(self):
        i=self.call('open','remote_desktop','acceptance','--source','test')['id']
        p=self.root/'autonomous-engineering-shadow.sh';p.write_text(p.read_text().replace("'model_verified':True","'model_verified':False"))
        self.start();d=self.terminal(i);self.assertEqual(d['incident']['state'],'failed')
        self.assertFalse((self.home/'repair-count').exists())
    def test_late_provider_answer_cannot_trigger_action(self):
        i=self.call('open','remote_desktop','acceptance','--source','test')['id']
        p=self.root/'autonomous-engineering-shadow.sh';s=p.read_text();s=s.replace("action='diagnostics.collect_more' if n==0 else 'runtime.managed_repair'","action='runtime.managed_repair'\nsubprocess.run([str(pathlib.Path(__file__).with_name('incident-orchestrator.py')),'recover','remote_desktop','acceptance','--source','test','--reason','independent recovery'],stdout=subprocess.DEVNULL,check=True)");p.write_text(s)
        self.start();d=self.terminal(i);time.sleep(.5)
        self.assertEqual(d['incident']['state'],'recovered');self.assertFalse((self.home/'repair-count').exists())

if __name__=='__main__':unittest.main(verbosity=2)
