#!/data/data/com.termux/files/usr/bin/python3
import json,os,subprocess,tempfile,time,unittest
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
        return subprocess.run([str(PROBE)],env=env,text=True,capture_output=True)
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
        policy=json.loads((ROOT/"claw-route-policy.json").read_text())
        remote=(ROOT.parent.parent/"openclaw-plugin-mobile-ui/src/companion/remoteBridge.ts").read_text()
        for token in ("HEALTH_HEARTBEAT_MS","heartbeatAt","runtimeRoot","healthHeartbeat.unref()"): self.assertIn(token,bridge)
        for token in ("process_uses_script","/proc/$pid/cmdline","grep -Fx","slack_bridge_on_current_root","supervisor_on_current_root","stop_supervisor","state=stale_runtime","fail slack_bridge"): self.assertIn(token,health)
        self.assertNotIn('pgrep -af "$pat" | grep -F -- "$script"',health)
        for token in ("sleep 3 9>&-","sleep 10 9>&-"): self.assertIn(token,guardian)
        for token in ("wait_for_lock_release","guardian/guardian.lock","health/health.lock","lock_release_timeout"): self.assertIn(token,bootstrap)
        self.assertNotIn("action=self_reconnect",health)
        self.assertIn("activate_current()",tier0)
        for token in ("CLAW_RPC_V1_B64","read_binary_file","patch_file"): self.assertIn(token,bridge)
        for token in ("patch_file","read_binary_file","write_binary_file"): self.assertIn(token,remote)
        self.assertEqual(policy["primary"],"slack_remote_bridge")
        self.assertIn("Routine bootstrap uses Slack", " ".join(policy["fallbackRules"]))
        for token in ("PRIMARY_HEALTHY","PRIMARY_REPAIRED","PRIMARY_REPAIR_FAILED","restart_companion","COMPANION_URL","companion_healthy"): self.assertIn(token,repair)
        for token in ("CLAWMOBILE_REPO_ROOT","$HOME/ClawMobile/openclaw-plugin-mobile-ui"): self.assertIn(token,lib)

if __name__=="__main__": unittest.main()
