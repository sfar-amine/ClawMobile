#!/data/data/com.termux/files/usr/bin/python3
"""Isolated runtime acceptance; no provider, service restart or real incident."""
import importlib.util,json,os,shutil,signal,sqlite3,subprocess,tempfile,time,unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class RuntimeBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.home=Path(self.tmp.name)
    def test_packaging_rejects_legacy_worker_without_bridge(self):
        m=load('tier0',ROOT/'tier0-control.py');src=self.home/'source';src.mkdir()
        (src/'incident-orchestrator-worker.sh').write_text('legacy worker')
        with self.assertRaisesRegex(RuntimeError,'engineering_bridge_incomplete'):m.validate_engineering_bridge(src)
        self.assertTrue(m.validate_engineering_bridge(ROOT))
    def test_rdc_shadow_budget_preserves_third_provider_curtain(self):
        text=(ROOT/'autonomous-engineering-shadow.sh').read_text()
        self.assertIn('[ "$component" = remote_desktop ] && max_calls=4',text)
        self.assertIn('existing four-call incident budget',text)
    def test_waiting_model_migrates_and_resumes_without_human_boundary(self):
        m=load('orch',ROOT/'incident-orchestrator.py');m.DB=self.home/'db.sqlite'
        row=m.open_incident('fixture','test','test','test')
        m.transition(row['id'],'diagnosing','test')
        waiting=m.transition(row['id'],'waiting_model','test',retry_after_s=60)
        self.assertGreater(waiting['next_retry'],time.time());self.assertFalse(waiting['human_boundary'])
        resumed=m.transition(row['id'],'diagnosing','test')
        self.assertEqual(resumed['next_retry'],0)
        self.assertEqual(m.show(row['id'])['incident']['state'],'diagnosing')
    def test_live_worker_routes_catalog_profile_to_existing_result_handler(self):
        runtime=self.home/'runtime';runtime.mkdir()
        for name in ['incident-orchestrator-worker.sh','incident-orchestrator.py','engineering-incident-result.py']:
            shutil.copy2(ROOT/name,runtime/name)
        stub=runtime/'engineering-repair.sh'
        stub.write_text('#!/data/data/com.termux/files/usr/bin/bash\nif [ "$1" = supports ]; then [ "$2" = reporting-incident-source ]; exit; fi\nprintf "run\\n" >>"$HOME/repair-calls"\necho \'{"status":"recovered"}\'\n')
        stub.chmod(0o755)
        for name in ['incident-continuation.py','learning-gate-close.sh']:
            f=runtime/name;f.write_text('#!/data/data/com.termux/files/usr/bin/bash\necho \'{"receipt_id":"fixture"}\'\n');f.chmod(0o755)
        (self.home/'.openclaw/health').mkdir(parents=True)
        env=dict(os.environ,HOME=str(self.home),CLAW_RUNTIME_ROOT=str(runtime))
        opened=subprocess.run([str(runtime/'incident-orchestrator.py'),'open','reporting-incident-source','acceptance-fixture','--source','engineering-code-monitor','--summary','isolated fixture'],env=env,capture_output=True,text=True,check=True)
        iid=json.loads(opened.stdout)['id'];worker=subprocess.Popen(['bash',str(runtime/'incident-orchestrator-worker.sh')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        try:
            state=None;deadline=time.monotonic()+12
            while time.monotonic()<deadline:
                with closing(sqlite3.connect(self.home/'.openclaw/incidents/orchestrator.db')) as con:
                    state=con.execute('select state from incidents where id=?',(iid,)).fetchone()[0]
                if state in {'recovered','failed'}:break
                time.sleep(.1)
            self.assertEqual(state,'recovered');self.assertEqual((self.home/'repair-calls').read_text().splitlines(),['run'])
            with closing(sqlite3.connect(self.home/'.openclaw/incidents/orchestrator.db')) as con:
                transitions=[json.loads(x[0])['to'] for x in con.execute("select payload from events where kind='transition' order by seq")]
            self.assertEqual(transitions,['diagnosing','planning','repairing','verifying','recovered'])
        finally:
            os.killpg(worker.pid,signal.SIGTERM);worker.wait(timeout=5)

if __name__=='__main__':unittest.main()
