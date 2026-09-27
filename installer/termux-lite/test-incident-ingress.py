#!/data/data/com.termux/files/usr/bin/python3
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("incident_ingress", ROOT / "incident-ingress.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)

class IncidentIngressTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        MOD.INBOX = base / "ingress"
        MOD.PROCESSED = base / "processed"
        MOD.REJECTED = base / "rejected"
        MOD.ensure_dirs()
        self.calls = []

        def fake_run(*args):
            self.calls.append(args)
            if "open" in args:
                return SimpleNamespace(returncode=0, stdout=json.dumps({"id": "incident123"}), stderr="")
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        self.old_run = MOD.run
        MOD.run = fake_run

    def tearDown(self):
        MOD.run = self.old_run
        self.tmp.cleanup()

    def test_external_boundary_is_recorded_without_local_diagnosis(self):
        p = MOD.INBOX / "external.json"
        p.write_text(json.dumps({
            "component": "chatgpt.tool_plane",
            "scope": "session-test",
            "source": "chatgpt",
            "summary": "execution rejected before S24",
            "kind": "foreground_blocker",
            "layer": "chatgpt-tool-plane",
            "evidence": {"remote_nonexec": "healthy"},
            "diagnose": False,
            "terminal_reason": "external boundary verified",
        }))
        MOD.process(p)
        out = json.loads((MOD.PROCESSED / "external.json").read_text())
        self.assertEqual(out["incident_id"], "incident123")
        flat = [" ".join(c) for c in self.calls]
        self.assertTrue(any(" open " in f" {x} " for x in flat))
        self.assertTrue(any(" observe " in f" {x} " for x in flat))
        self.assertTrue(any(" transition " in f" {x} " and " failed " in f" {x} " for x in flat))
        self.assertFalse(any(" diagnosing " in f" {x} " for x in flat))

    def test_local_repairable_blocker_enters_diagnosing(self):
        p = MOD.INBOX / "local.json"
        p.write_text(json.dumps({
            "component": "remote_desktop",
            "scope": "runtime",
            "source": "chatgpt",
            "summary": "local transport failure",
            "diagnose": True,
        }))
        MOD.process(p)
        flat = [" ".join(c) for c in self.calls]
        self.assertTrue(any(" transition " in f" {x} " and " diagnosing " in f" {x} " for x in flat))

if __name__ == "__main__":
    unittest.main()
