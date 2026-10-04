#!/data/data/com.termux/files/usr/bin/python3
import json,os,re,subprocess,sys,tempfile,time,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parent
PROBE=ROOT/"claw-slack-bridge-health.py"

class SlackRuntimeContractTests(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory()
        self.d=Path(self.t.name)
        sec=self.d/"secrets"; sec.mkdir()
        (sec/"app-token").write_text("xapp-test")
        (sec/"bot-token").write_text("xoxb-test")
        (self.d/"config.json").write_text(json.dumps({
            "channelId":"C_TEST","allowedUserIds":["U_TEST"],
            "appTokenFile":str(sec/"app-token"),"botTokenFile":str(sec/"bot-token")}))
    def tearDown(self): self.t.cleanup()
    def run_probe(self,health):
        (self.d/"health.json").write_text(json.dumps(health))
        env={**os.environ,"CLAW_SLACK_STATE_DIR":str(self.d)}
        return subprocess.run([sys.executable,str(PROBE)],env=env,text=True,capture_output=True)
    def test_live_delivery_attention_does_not_request_restart(self):
        r=self.run_probe({"state":"degraded","connected":True,"heartbeatAt":int(time.time()*1000),
                          "restartRecommended":False,"deliveryState":"attention_required","queue":{"attention":1}})
        self.assertEqual(r.returncode,3,r.stdout+r.stderr)
        self.assertFalse(json.loads(r.stdout)["restartRecommended"])
    def test_stale_delivery_attention_still_requests_repair(self):
        r=self.run_probe({"state":"degraded","connected":True,"heartbeatAt":int(time.time()*1000)-120000,
                          "restartRecommended":False,"deliveryState":"attention_required"})
        self.assertEqual(r.returncode,1,r.stdout+r.stderr)
        self.assertEqual(json.loads(r.stdout)["reason"],"heartbeat_stale")
    def test_fresh_heartbeat_is_healthy(self):
        now=int(time.time()*1000)
        r=self.run_probe({"state":"healthy","connected":True,"heartbeatAt":now,"updatedAt":now-120000,"runtimeRoot":"/release"})
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertEqual(json.loads(r.stdout)["state"],"healthy")
    def test_stale_heartbeat_is_degraded(self):
        now=int(time.time()*1000)
        r=self.run_probe({"state":"healthy","connected":True,"heartbeatAt":now-120000})
        self.assertEqual(r.returncode,1)
        self.assertEqual(json.loads(r.stdout)["reason"],"heartbeat_stale")
    def test_legacy_updated_at_still_supported(self):
        r=self.run_probe({"state":"healthy","connected":True,"updatedAt":int(time.time()*1000)})
        self.assertEqual(r.returncode,0)
    def test_source_contracts(self):
        bridge=(ROOT/"claw-slack-bridge.mjs").read_text()
        health=(ROOT/"samantha-health-manager.sh").read_text()
        tier0=(ROOT/"tier0-control.py").read_text()
        guardian=(ROOT/"samantha-root-guardian.sh").read_text()
        bootstrap=(ROOT/"tier0-bootstrap.sh").read_text()
        repair=(ROOT/"claw-primary-repair.sh").read_text()
        lib=(ROOT/"lib.sh").read_text()
        learning_gate=(ROOT/"learning-gate.py").read_text()
        engineering_close=(ROOT/"autonomous-engineering-close.sh").read_text()
        incident_close=(ROOT/"incident-close.sh").read_text()
        policy=json.loads((ROOT/"claw-route-policy.json").read_text())
        remote_path=ROOT.parent.parent/"openclaw-plugin-mobile-ui/src/companion/remoteBridge.ts"
        if not remote_path.exists():
            manifest_path=ROOT.parent/"manifest.json"
            if manifest_path.exists():
                source=Path(json.loads(manifest_path.read_text()).get("source",""))
                candidate=source.parent.parent/"openclaw-plugin-mobile-ui/src/companion/remoteBridge.ts"
                if candidate.exists(): remote_path=candidate
        if not remote_path.exists():
            remote_path=Path.home()/"ClawMobile/openclaw-plugin-mobile-ui/src/companion/remoteBridge.ts"
        remote=remote_path.read_text()
        for token in ("HEALTH_HEARTBEAT_MS","heartbeatAt","runtimeRoot","healthHeartbeat.unref()"): self.assertIn(token,bridge)
        for token in ("process_uses_script","/proc/$pid/cmdline","grep -Fx","slack_bridge_on_current_root","supervisor_on_current_root","stop_supervisor","state=stale_runtime","fail slack_bridge"): self.assertIn(token,health)
        self.assertNotIn('pgrep -af "$pat" | grep -F -- "$script"',health)
        # The contract is descriptor release, independent of the current delay value.
        for delay in re.finditer(r'\bsleep\s+\d+',guardian):
            self.assertTrue(guardian[delay.end():].lstrip().startswith('9>&-'))
        self.assertIn("sleep 10 9>&-",guardian)
        for token in ("wait_for_lock_release","guardian/guardian.lock","health/health.lock","lock_release_timeout"): self.assertIn(token,bootstrap)
        self.assertNotIn("action=self_reconnect",health)
        self.assertIn("activate_current()",tier0)
        self.assertIn('"$rc" -eq 3',health)
        self.assertIn("PRIMARY_DELIVERY_ATTENTION",repair)
        for token in ("CLAW_RPC_V1_B64","read_binary_file","patch_file","action=use_b64","CORRELATION_REQUIRED","correlation_required:","stepId: String(request?.stepId"): self.assertIn(token,bridge)
        for token in ("patch_file","read_binary_file","write_binary_file"): self.assertIn(token,remote)
        self.assertEqual(policy["primary"],"slack_remote_bridge")
        self.assertIn("Routine bootstrap uses Slack", " ".join(policy["fallbackRules"]))
        for token in ("PRIMARY_HEALTHY","PRIMARY_REPAIRED","PRIMARY_REPAIR_FAILED","restart_companion","COMPANION_URL","companion_healthy"): self.assertIn(token,repair)
        for token in ("CLAWMOBILE_REPO_ROOT","$HOME/ClawMobile/openclaw-plugin-mobile-ui"): self.assertIn(token,lib)
        for token in ("closure_id_conflict","no_explicit_reusable_learning_supplied","registry_update_required","write_howto"): self.assertIn(token,learning_gate)
        for token in ("learning-gate-close.sh","learning_gate="): self.assertIn(token,engineering_close)
        self.assertIn("learning-gate-close.sh",incident_close)

if __name__=="__main__": unittest.main()
