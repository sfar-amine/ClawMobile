#!/data/data/com.termux/files/usr/bin/python3
import contextlib, datetime as dt, importlib.util, io, json, os, shutil, subprocess, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parent
import sys; sys.path.insert(0,str(ROOT))
from host_test_support import adapt_shebangs, host_cmd
P=ROOT/"learning-gate.py"
spec=importlib.util.spec_from_file_location("learning_gate",P)
lg=importlib.util.module_from_spec(spec); spec.loader.exec_module(lg)

class LearningGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.base=Path(self.tmp.name)
        self.workspace=self.base/"workspace"
        self.state=self.base/"learning"
        reg=self.workspace/"ui-playbooks"/"capabilities"/"registry.json"
        reg.parent.mkdir(parents=True)
        reg.write_text(json.dumps({"capabilities":[
            {"id":"device.remote_bridge","name":"Remote Bridge","aliases":["slack bridge"],"status":"e2e_validated"},
            {"id":"device.remote_desktop","name":"Remote Desktop","aliases":["rdc"],"status":"e2e_validated"}
        ]}))
        (self.workspace/"context").mkdir(parents=True)
        lg.STATE=self.state; lg.RECEIPTS=self.state/"receipts"; lg.LEDGERS=self.state/"capabilities"
        lg.REGISTRY_CANDIDATES=self.state/"registry-candidates"; lg.LOCK=self.state/"gate.lock"
        lg.WORKSPACE=self.workspace; lg.REGISTRY=reg
        lg.HOWTO_ROOT=self.state/"howto"
        lg.JOURNAL=self.state/"journal"/"DEVELOPMENT_JOURNAL.md"
        lg.INCIDENT_DB=self.base/"missing.db"

    def tearDown(self):
        self.tmp.cleanup()

    def run_close(self, **kwargs):
        defaults=dict(source="manual",closure_id="c1",component="slack_bridge",status="recovered",
                      summary="bridge recovered",capability_id="",learning_file="",incident_id="",final_fix="")
        defaults.update(kwargs)
        buf=io.StringIO()
        with contextlib.redirect_stdout(buf):
            lg.close(SimpleNamespace(**defaults))
        return json.loads(buf.getvalue())

    def test_validated_learning_howto_and_idempotence(self):
        learning=self.base/"learning.json"
        learning.write_text(json.dumps({
            "symptom":"socket healthy but executor unavailable",
            "root_cause":"Companion was down",
            "failed_attempts":["restarting only the Slack socket"],
            "final_fix":"repair Companion and Slack Bridge as one chain",
            "reusable_learning":"treat Slack transport and Companion executor health separately",
            "regression_guard":"packaged recovery test plus live ping",
            "how_to":["probe Companion before restarting Slack","use requestId before replay"],
            "evidence":["test:remote-bridge","live:e2e-ping"],
            "confidence":"stable",
            "capability_truth_changed":True,
            "registry_note":"Remote Bridge health is an end-to-end chain."
        }))
        first=self.run_close(learning_file=str(learning))
        self.assertEqual(first["capability_id"],"device.remote_bridge")
        self.assertTrue(first["context_text"].startswith("IMPROVEMENT_CANDIDATE_V1:"))
        payload=json.loads(first["context_text"].split(":",1)[1])
        self.assertEqual(payload["type"],"rule")
        self.assertEqual(payload["learning_type"],"closure_learning")
        self.assertEqual(payload["capability"],"device.remote_bridge")
        self.assertTrue(first["howto_updated"])
        # Single code root (02/11): the registry of a checkout is never edited; the change is a candidate only.
        registry_before=lg.REGISTRY.read_text()
        self.assertFalse(first["registry_updated"])
        self.assertTrue(first["registry_update_required"])
        self.assertEqual(registry_before,lg.REGISTRY.read_text())
        self.assertNotIn("evidence",json.loads(registry_before)["capabilities"][0])
        candidate=json.loads(Path(first["registry_candidate"]).read_text())
        self.assertEqual(candidate["capability_id"],"device.remote_bridge")
        self.assertEqual(candidate["proposal"]["evidence_append"],"capabilities/howto/device.remote_bridge.md")
        self.assertEqual(candidate["proposal"]["notes_append"],"Remote Bridge health is an end-to-end chain.")
        self.assertTrue(Path(first["registry_candidate"]).is_relative_to(lg.REGISTRY_CANDIDATES))
        self.assertFalse((self.workspace/"ui-playbooks"/"capabilities"/"howto").exists())
        howto=(lg.HOWTO_ROOT/"device.remote_bridge.md").read_text()
        self.assertIn("probe Companion before restarting Slack",howto)
        second=self.run_close(learning_file=str(learning))
        self.assertEqual(first["receipt_id"],second["receipt_id"])
        self.assertEqual(howto,(lg.HOWTO_ROOT/"device.remote_bridge.md").read_text())
        ledger=(lg.LEDGERS/"device.remote_bridge.jsonl").read_text().splitlines()
        self.assertEqual(len(ledger),1)
        with self.assertRaises(SystemExit):
            self.run_close(learning_file=str(learning),summary="different")

    def test_default_capture_paths_are_gate_data_outside_any_checkout(self):
        self.assertEqual(P.parent/"learning-gate.py",P)
        env={k:v for k,v in os.environ.items() if k not in ("CLAW_WORKSPACE","CLAW_UI_PLAYBOOKS_ROOT","CLAW_LEARNING_GATE_ROOT")}
        home=self.base/"home"
        pin=home/".openclaw/runtime-ui-playbooks/current/capabilities"; pin.mkdir(parents=True)
        (pin/"registry.json").write_text('{"capabilities":[]}')
        work=home/".openclaw/workspace/ui-playbooks/capabilities"; work.mkdir(parents=True)
        (work/"registry.json").write_text('{"capabilities":[]}')
        code="import importlib.util,sys,json;s=importlib.util.spec_from_file_location('g',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps([str(m.REGISTRY),str(m.HOWTO_ROOT),str(m.JOURNAL)]))"
        out=json.loads(subprocess.run([sys.executable,"-c",code,str(P)],env={**env,"HOME":str(home)},capture_output=True,text=True,check=True).stdout)
        state=home/".openclaw/learning-gate"
        self.assertEqual(out,[str(pin/"registry.json"),str(state/"howto"),str(state/"journal/DEVELOPMENT_JOURNAL.md")])
        self.assertFalse((home/".openclaw/health/code-root/events/learning_gate.json").exists())
        # Pin missing: the workspace registry is still read (never blocking) and the fallback is recorded.
        (pin/"registry.json").unlink()
        out=json.loads(subprocess.run([sys.executable,"-c",code,str(P)],env={**env,"HOME":str(home)},capture_output=True,text=True,check=True).stdout)
        self.assertEqual(out[0],str(work/"registry.json"))
        event=json.loads((home/".openclaw/health/code-root/events/learning_gate.json").read_text())
        self.assertEqual((event["component"],event["event"]),("learning_gate","fallback"))

    def test_no_learning_is_provisional_observation(self):
        out=self.run_close(closure_id="no-learning")
        self.assertEqual(out["confidence"],"provisional")
        self.assertEqual(out["no_learning_reason"],"no_explicit_reusable_learning_supplied")
        self.assertTrue(out["context_text"].startswith("LEARNING_GATE_V1:"))
        self.assertFalse(out["howto_updated"])

    def test_development_journal_rotates_on_month_boundary(self):
        journal=lg.JOURNAL
        journal.parent.mkdir(parents=True,exist_ok=True)
        journal.write_text('# Development Journal\n\nold month\n')
        old=dt.datetime(2026,9,30,12,tzinfo=dt.timezone.utc).timestamp()
        os.utime(journal,(old,old))
        archive=lg.rotate_monthly_journal(journal,dt.datetime(2026,10,1,tzinfo=dt.timezone.utc))
        self.assertEqual(archive,journal.with_name('DEVELOPMENT_JOURNAL.2026-09.md'))
        self.assertFalse(journal.exists())
        self.assertIn('old month',archive.read_text())
        self.run_close(closure_id='october')
        self.assertTrue(journal.exists())
        self.assertIn('learning-gate:',journal.read_text())

    def make_runtime_root(self):
        runtime=self.base/"runtime"; runtime.mkdir(exist_ok=True)
        for name in ("learning-gate.py","learning-gate-close.sh"):
            shutil.copy2(ROOT/name,runtime/name); (runtime/name).chmod(0o755)
        context=runtime/"context-event.sh"
        context.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/context-events.log\"\nprintf '%064d\\n' 0\n")
        context.chmod(0o755)
        wa=runtime/"whatsapp-owner-send.sh"; wa.write_text("#!/bin/sh\nexit 0\n"); wa.chmod(0o755)
        mail=runtime/"incident-email.sh"; mail.write_text("#!/bin/sh\nexit 1\n"); mail.chmod(0o755)
        adapt_shebangs(runtime)  # copies seulement : shebangs Termux adaptés hors Termux
        return runtime

    def subprocess_env(self, runtime):
        env={**os.environ,"HOME":str(self.base),"CLAW_RUNTIME_ROOT":str(runtime),
             "CLAW_WORKSPACE":str(self.workspace),"CLAW_LEARNING_GATE_ROOT":str(self.state)}
        return env

    def test_engineering_close_uses_gate(self):
        runtime=self.make_runtime_root()
        learning=self.base/"engineering.json"
        learning.write_text(json.dumps({"reusable_learning":"complex RPC payloads use B64 envelope","how_to":["prefer CLAW_RPC_V1_B64 for complex payloads"],"confidence":"validated"}))
        proc=subprocess.run([*host_cmd(ROOT/"autonomous-engineering-close.sh"),"recovered","slack_bridge","fixed",str(learning)],
                            env=self.subprocess_env(runtime),text=True,capture_output=True)
        self.assertEqual(proc.returncode,0,proc.stdout+proc.stderr)
        closure=(self.base/".openclaw"/"autonomous-engineering"/"closure.log").read_text()
        self.assertIn("learning_gate=ok",closure)
        self.assertIn("IMPROVEMENT_CANDIDATE_V1:",(self.base/"context-events.log").read_text())

    def test_legacy_incident_closes_after_gate(self):
        runtime=self.make_runtime_root()
        queue=self.base/".openclaw"/"incidents"/"queue"/"inc1"
        queue.mkdir(parents=True)
        (queue/"status").write_text("pending")
        (queue/"message").write_text("slack_bridge down")
        proc=subprocess.run([*host_cmd(ROOT/"incident-close.sh"),"slack_bridge","verified recovery"],
                            env=self.subprocess_env(runtime),text=True,capture_output=True)
        self.assertEqual(proc.returncode,0,proc.stdout+proc.stderr)
        self.assertEqual((queue/"status").read_text(),"closed")
        # M3: LEARNING_GATE_V1 stays in the gate receipt/journal, never in the shared memory.
        log=self.base/"context-events.log"
        self.assertNotIn("LEARNING_GATE_V1:",log.read_text() if log.exists() else "")
        receipts=list((self.state/"receipts").glob("*.json"))
        self.assertTrue(any(json.loads(x.read_text())["context_text"].startswith("LEARNING_GATE_V1:") for x in receipts))

    def test_legacy_incident_stays_recovered_if_gate_fails(self):
        runtime=self.make_runtime_root()
        (runtime/"learning-gate-close.sh").write_text("#!/bin/sh\nexit 1\n")
        (runtime/"learning-gate-close.sh").chmod(0o755)
        queue=self.base/".openclaw"/"incidents"/"queue"/"inc2"
        queue.mkdir(parents=True)
        (queue/"status").write_text("pending")
        (queue/"message").write_text("slack_bridge down")
        subprocess.run([*host_cmd(ROOT/"incident-close.sh"),"slack_bridge","verified recovery"],
                       env=self.subprocess_env(runtime),text=True,capture_output=True)
        self.assertEqual((queue/"status").read_text(),"recovered")
        self.assertFalse((queue/"closed").exists())

if __name__=="__main__":
    unittest.main()
