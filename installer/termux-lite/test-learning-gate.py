#!/data/data/com.termux/files/usr/bin/python3
import contextlib, importlib.util, io, json, os, shutil, subprocess, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parent
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
        lg.HOWTO_ROOT=self.workspace/"ui-playbooks"/"capabilities"/"howto"
        lg.JOURNAL=self.workspace/"context"/"DEVELOPMENT_JOURNAL.md"
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
        self.assertTrue(first["howto_updated"])
        self.assertTrue(first["registry_updated"])
        self.assertFalse(first["registry_update_required"])
        registry=json.loads(lg.REGISTRY.read_text())
        item=next(x for x in registry["capabilities"] if x["id"]=="device.remote_bridge")
        self.assertIn("capabilities/howto/device.remote_bridge.md",item["evidence"])
        howto=(lg.HOWTO_ROOT/"device.remote_bridge.md").read_text()
        self.assertIn("probe Companion before restarting Slack",howto)
        second=self.run_close(learning_file=str(learning))
        self.assertEqual(first["receipt_id"],second["receipt_id"])
        self.assertEqual(howto,(lg.HOWTO_ROOT/"device.remote_bridge.md").read_text())
        ledger=(lg.LEDGERS/"device.remote_bridge.jsonl").read_text().splitlines()
        self.assertEqual(len(ledger),1)
        with self.assertRaises(SystemExit):
            self.run_close(learning_file=str(learning),summary="different")

    def test_no_learning_is_provisional_observation(self):
        out=self.run_close(closure_id="no-learning")
        self.assertEqual(out["confidence"],"provisional")
        self.assertEqual(out["no_learning_reason"],"no_explicit_reusable_learning_supplied")
        self.assertTrue(out["context_text"].startswith("LEARNING_GATE_V1:"))
        self.assertFalse(out["howto_updated"])

    def make_runtime_root(self):
        runtime=self.base/"runtime"; runtime.mkdir(exist_ok=True)
        for name in ("learning-gate.py","learning-gate-close.sh"):
            shutil.copy2(ROOT/name,runtime/name); (runtime/name).chmod(0o755)
        context=runtime/"context-event.sh"
        context.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/context-events.log\"\nprintf '%064d\\n' 0\n")
        context.chmod(0o755)
        wa=runtime/"whatsapp-owner-send.sh"; wa.write_text("#!/bin/sh\nexit 0\n"); wa.chmod(0o755)
        mail=runtime/"incident-email.sh"; mail.write_text("#!/bin/sh\nexit 1\n"); mail.chmod(0o755)
        return runtime

    def subprocess_env(self, runtime):
        env={**os.environ,"HOME":str(self.base),"CLAW_RUNTIME_ROOT":str(runtime),
             "CLAW_WORKSPACE":str(self.workspace),"CLAW_LEARNING_GATE_ROOT":str(self.state)}
        return env

    def test_engineering_close_uses_gate(self):
        runtime=self.make_runtime_root()
        learning=self.base/"engineering.json"
        learning.write_text(json.dumps({"reusable_learning":"complex RPC payloads use B64 envelope","how_to":["prefer CLAW_RPC_V1_B64 for complex payloads"],"confidence":"validated"}))
        proc=subprocess.run([str(ROOT/"autonomous-engineering-close.sh"),"recovered","slack_bridge","fixed",str(learning)],
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
        proc=subprocess.run([str(ROOT/"incident-close.sh"),"slack_bridge","verified recovery"],
                            env=self.subprocess_env(runtime),text=True,capture_output=True)
        self.assertEqual(proc.returncode,0,proc.stdout+proc.stderr)
        self.assertEqual((queue/"status").read_text(),"closed")
        self.assertIn("LEARNING_GATE_V1:",(self.base/"context-events.log").read_text())

    def test_legacy_incident_stays_recovered_if_gate_fails(self):
        runtime=self.make_runtime_root()
        (runtime/"learning-gate-close.sh").write_text("#!/bin/sh\nexit 1\n")
        (runtime/"learning-gate-close.sh").chmod(0o755)
        queue=self.base/".openclaw"/"incidents"/"queue"/"inc2"
        queue.mkdir(parents=True)
        (queue/"status").write_text("pending")
        (queue/"message").write_text("slack_bridge down")
        subprocess.run([str(ROOT/"incident-close.sh"),"slack_bridge","verified recovery"],
                       env=self.subprocess_env(runtime),text=True,capture_output=True)
        self.assertEqual((queue/"status").read_text(),"recovered")
        self.assertFalse((queue/"closed").exists())

if __name__=="__main__":
    unittest.main()
