#!/usr/bin/env python3
"""SAM-MIG-CC-001 V2.2 — core side of the dialogue coordinator (option B, ADR-DIALOGUE programme doc 57).

- model-fast-path.py runs the coordinator of the pinned playbook IN ITS OWN PROCESS (no new process): wiring of the
  ports, `--dialogue turn|handoff|abort|preview`, fail-closed when the coordinator cannot be imported (T-X05).
- Identity (F-15, T-H06): the vector below is pinned identically in samantha-ui-playbooks
  tests/test_dialogue_static.py against skill_intelligence/dialogue/handoff.py.
- Maintenance lock (§12.1): companion-deploy.sh is the only writer of the durable marker; epoch, acceptance list,
  fail-closed reading, and the WhatsApp channel is never stopped by it.
- Real fixture: S24 runs registry (16/10, sanitized) — legacy pending clarifications are shown abandoned (D-C).
"""
from __future__ import annotations

import base64
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
HELPER = HERE / "model-fast-path.py"
DEPLOY = HERE / "companion-deploy.sh"
FIXTURE = REPO / "openclaw-plugin-mobile-ui/fixtures/s24-2026-10-16/mig22/runs-clarification-inventory.json"


def load_helper():
    spec = importlib.util.spec_from_file_location("model_fast_path_dialogue_test", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STUB_COORDINATOR = '''
import json
CALLS = []
def preview_resolution(text, ports, *, surface="mcp", caller="owner"):
    return {"outcome": "READY", "statusTable": "dialogue-status-table-v1", "preview": text, "surface": surface}
def handle_admitted_event(event, ports, *, policy=None):
    resolved = ports.resolve(event["text"], {"caller": event.get("caller"), "eventKey": "evt-1"})
    return {"outcome": "COMPLETED", "handled": True, "event": event, "policy": policy, "resolved": resolved.get("status"),
            "hasExecute": callable(getattr(ports, "execute", None)), "hasStatus": callable(getattr(ports, "mission_status", None))}
class Coordinator:
    def __init__(self, ports):
        self.ports = ports
        self.store = None
    def continue_handoff(self, event, goal_ref, policy, abort=False):
        return {"outcome": "DENIED" if abort else "COMPLETED", "goalRef": goal_ref, "abort": abort, "handled": True}
'''


class DialogueWiringTests(unittest.TestCase):
    def setUp(self):
        self.mfp = load_helper()
        self.tmp = tempfile.TemporaryDirectory()
        self.ui = Path(self.tmp.name) / "ui"
        pkg = self.ui / "skill_intelligence" / "dialogue"
        pkg.mkdir(parents=True)
        (self.ui / "skill_intelligence" / "__init__.py").write_text("")
        (pkg / "__init__.py").write_text("")
        (pkg / "coordinator.py").write_text(STUB_COORDINATOR)
        for name in [n for n in sys.modules if n.startswith("skill_intelligence")]:
            del sys.modules[name]

    def tearDown(self):
        if str(self.ui) in sys.path:
            sys.path.remove(str(self.ui))
        for name in [n for n in sys.modules if n.startswith("skill_intelligence")]:
            del sys.modules[name]
        self.tmp.cleanup()

    def test_T_H06_identity_vector_matches_playbooks_codec(self):
        origin = "dlg1:" + "0" * 40
        task = self.mfp._stable_identity("capfirst", origin)
        self.assertEqual(task, "capfirst:d105d2cc6818ea96c37a34becfbaff7f")
        import hashlib
        self.assertEqual("capfirst-" + hashlib.sha256((task + ":execute").encode()).hexdigest()[:32],
                         "capfirst-f0448328bcfbee2d9511b87009cc3f8b")

    def test_coordinator_runs_in_process_with_fast_path_ports(self):
        self.mfp.try_fast_path = lambda *a, **k: {"status": "eligible", "decision": {"decisionId": "d1"},
                                                  "resolution": {"selected": {}}}
        out = self.mfp.run_dialogue("mon solde", mode="turn", ui_root=self.ui, surface="whatsapp", caller="owner",
                                    timeout=30, event={"surface": "whatsapp", "conversationKey": "k", "eventRef": "e"},
                                    policy={"modelAllowed": True})
        self.assertEqual(out["outcome"], "COMPLETED")
        self.assertEqual(out["event"]["text"], "mon solde")
        self.assertEqual(out["event"]["caller"], "owner")
        self.assertEqual(out["resolved"], "eligible")
        self.assertTrue(out["hasExecute"] and out["hasStatus"])
        self.assertEqual(out["policy"], {"modelAllowed": True})
        preview = self.mfp.run_dialogue("x", mode="preview", ui_root=self.ui, surface="external_mcp", caller="owner",
                                        timeout=15)
        self.assertEqual(preview["outcome"], "READY")
        abort = self.mfp.run_dialogue("x", mode="abort", ui_root=self.ui, surface="claw_live", caller="owner",
                                      timeout=15, event={}, goal_ref="goal-0123456789abcdef0123")
        self.assertTrue(abort["abort"])

    def test_T_X05_coordinator_unavailable_fails_closed(self):
        missing = Path(self.tmp.name) / "old-pinned-playbook"
        missing.mkdir()
        out = self.mfp.run_dialogue("mon solde", mode="turn", ui_root=missing, surface="whatsapp", caller="owner",
                                    timeout=30, event={}, policy={})
        self.assertEqual(out["outcome"], "TECHNICAL_FAILURE")
        self.assertEqual(out["reasonCode"], "coordinator_unavailable")
        self.assertFalse(out["modelAllowed"])
        self.assertTrue(out["handled"])

    def test_ports_reuse_the_in_process_resolution_and_revalidate_otherwise(self):
        seen = []
        self.mfp.try_fast_path = lambda *a, **k: seen.append(("try", k.get("prepared_decision"), k.get("execute"))) or \
            {"status": "eligible", "decision": {"decisionId": "d1"}, "resolution": {"r": 1}}
        self.mfp.execute_resolved = lambda *a, **k: seen.append(("resolved", a[1], k["origin_id"])) or {"status": "hit"}
        ports = self.mfp.FastPathPorts(self.ui, surface="whatsapp", caller="owner", timeout=30)
        ports.resolve("x", {"eventKey": "evt-1"})
        ports.execute("x", {"decisionId": "d1"}, "dlg1:" + "a" * 40, "FAST", {})
        self.assertEqual(seen[-1], ("resolved", {"r": 1}, "dlg1:" + "a" * 40))
        ports.execute("x", {"decisionId": "other"}, "dlg1:" + "b" * 40, "FAST", {})
        self.assertEqual(seen[-1], ("try", {"decisionId": "other"}, True), "unknown decision is revalidated by the Graph")
        self.assertEqual(ports._caller({"caller": "attacker"}), "other")

    def test_cli_dialogue_mode_reads_base64_event_and_policy(self):
        env = {**os.environ, "CLAW_UI_PLAYBOOKS_ROOT": str(self.ui),
               "CLAW_DIALOGUE_EVENT_B64": base64.b64encode(json.dumps({"surface": "app", "conversationKey": "k",
                                                                       "eventRef": "crid"}).encode()).decode(),
               "CLAW_DIALOGUE_POLICY_B64": base64.b64encode(b'{"deferHandoff": true}').decode()}
        stub_runner = (
            "import importlib.util,sys,json;"
            f"s=importlib.util.spec_from_file_location('m',{str(HELPER)!r});m=importlib.util.module_from_spec(s);"
            "s.loader.exec_module(m);"
            "m.try_fast_path=lambda *a,**k:{'status':'miss'};"
            "sys.argv=['model-fast-path.py','--dialogue','turn','--surface','claw_live','--caller','owner','bonjour'];"
            "raise SystemExit(m.main())")
        run = subprocess.run([sys.executable, "-c", stub_runner], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(run.returncode, 0, run.stderr)
        out = json.loads(run.stdout)
        self.assertEqual(out["event"]["conversationKey"], "k")
        self.assertEqual(out["policy"], {"deferHandoff": True})


class MaintenanceMarkerTests(unittest.TestCase):
    def deploy(self, home, *args):
        env = {**os.environ, "HOME": home, "CLAW_DIALOGUE_HOME": os.path.join(home, ".openclaw", "samantha-dialogue")}
        return subprocess.run(["bash", str(DEPLOY), "--maintenance", *args], env=env, capture_output=True, text=True,
                              timeout=30)

    def test_lock_written_only_by_deploy_script_with_epoch(self):
        with tempfile.TemporaryDirectory() as home:
            marker = Path(home) / ".openclaw/samantha-dialogue/maintenance.json"
            self.assertEqual(json.loads(self.deploy(home, "status").stdout)["state"], "open")
            allowed = "conv-" + "a" * 24
            closed = self.deploy(home, "close", "--allow", allowed)
            self.assertEqual(closed.returncode, 0, closed.stderr)
            value = json.loads(marker.read_text())
            self.assertEqual((value["state"], value["epoch"], value["acceptance"], value["by"]),
                             ("closed", 1, [allowed], "companion-deploy.sh"))
            self.assertEqual(oct(marker.stat().st_mode & 0o777), "0o600")
            self.assertEqual(json.loads(self.deploy(home, "close").stdout)["epoch"], 1, "closing twice keeps the epoch")
            opened = json.loads(self.deploy(home, "open").stdout)
            self.assertEqual((opened["state"], opened["epoch"]), ("open", 1))
            self.assertEqual(json.loads(marker.read_text())["acceptance"], [])
            self.assertEqual(json.loads(self.deploy(home, "close").stdout)["epoch"], 2)
            receipts = list((Path(home) / ".openclaw/deploys").glob("maintenance-*.json"))
            self.assertTrue(receipts)
            self.assertNotEqual(self.deploy(home, "close", "--allow", "+21600000000").returncode, 0)
            self.assertNotEqual(self.deploy(home, "reopen").returncode, 0)

    def test_marker_has_a_single_writer_and_never_stops_whatsapp(self):
        writers = []
        for path in REPO.rglob("*"):
            if path.is_file() and path.suffix in {".sh", ".py", ".ts", ".mjs", ".cjs"} and "node_modules" not in path.parts \
                    and "dist" not in path.parts and path.name != Path(__file__).name:
                text = path.read_text(errors="ignore")
                if "maintenance.json" in text:
                    writers.append(path.relative_to(REPO).as_posix())
        self.assertEqual(writers, ["installer/termux-lite/companion-deploy.sh"])
        section = DEPLOY.read_text().split('if [ "${1:-}" = "--maintenance" ]; then', 1)[1].split("\nfi\n", 1)[0]
        self.assertNotRegex(section, r"pkill|openclaw\s+(channels|gateway)|whatsapp.*(stop|logout)")


class LegacyClarificationInventoryTests(unittest.TestCase):
    def test_real_s24_runs_registry_inventory(self):
        data = json.loads(FIXTURE.read_text())
        runs = data["runs"]
        self.assertEqual(data["source"]["action_key"], "sammig-v22-L3-coord-20261016")
        states = {}
        for run in runs:
            states[run.get("clarificationState")] = states.get(run.get("clarificationState"), 0) + 1
        self.assertEqual(states.get("pending", 0), 0, "16/10: no pending clarification to invalidate at cutover")
        self.assertEqual(states.get("resolved"), 3)
        for run in runs:
            self.assertRegex(run["runId"], r"^run-[a-f0-9]{12}$")
            self.assertNotIn("text", run)


if __name__ == "__main__":
    unittest.main()
