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
        for token in ("HEALTH_HEARTBEAT_MS","heartbeatAt","runtimeRoot","healthHeartbeat.unref()"): self.assertIn(token,bridge)
        for token in ("slack_bridge_on_current_root","supervisor_on_current_root","stop_supervisor","state=stale_runtime","fail slack_bridge"): self.assertIn(token,health)
        self.assertNotIn("action=self_reconnect",health)
        self.assertIn("activate_current()",tier0)

if __name__=="__main__": unittest.main()
