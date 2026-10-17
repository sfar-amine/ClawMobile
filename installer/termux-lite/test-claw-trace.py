#!/usr/bin/env python3
"""F3 (doc 62): one command rebuilds a window across the owners, in order, without the user's text."""
import json, os, sqlite3, subprocess, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class ClawTraceTests(unittest.TestCase):
    def test_window_is_merged_in_order_and_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp); oc = home / ".openclaw"
            (oc / "health").mkdir(parents=True)
            (oc / "health" / "companion.stderr.log").write_text(
                "2026-10-17T23:35:14.900+01:00 [claw-live-warm] token: gemini_live_token_helper_failed exit=1\n"
                "unstamped legacy line is ignored\n")
            (oc / "health" / "health.log").write_text(
                "2026-10-17T23:35:10+01:00 component=health-manager service=companion state=healthy\n"
                "2026-10-17T22:00:00+01:00 component=health-manager outside window\n")
            (oc / "samantha-dialogue").mkdir()
            db = sqlite3.connect(oc / "samantha-dialogue" / "dialogue.sqlite")
            db.execute("create table transitions (id integer primary key, at int, conversation_ref text, goal_ref text,"
                       " event_kind text, from_state text, to_state text, outcome text, reason_code text, revision int)")
            at = 1792276515000  # 2026-10-17T23:35:15+01:00
            db.execute("insert into transitions(at,goal_ref,event_kind,to_state,outcome,reason_code) values (?,?,?,?,?,?)",
                       (at, "goal-x", "HANDOFF_OBSERVED", "CLOSED", "FAILED", "web_deadline_exceeded"))
            db.commit(); db.close()
            (oc / "clawmobile-companion").mkdir()
            (oc / "clawmobile-companion" / "runs.json").write_text(json.dumps({"runs": [{
                "runId": "run_1", "acceptedAt": at - 3000, "updatedAt": at + 1000, "state": "failed",
                "executionSource": "capability_first", "decision": {"capability": "samantha.app.web.answer"},
                "userText": "SECRET_PRIVATE_QUESTION", "error": "Claw could not complete the known capability."}]}))
            env = dict(os.environ, HOME=str(home), TZ="Africa/Tunis")
            out = subprocess.run(["python3", str(HERE / "claw-trace.py"), "--since", "2026-10-17T23:30:00+01:00",
                                  "--until", "2026-10-17T23:40:00+01:00", "--no-app", "--json"],
                                 env=env, capture_output=True, text=True, check=True).stdout
            rows = [json.loads(line) for line in out.splitlines()]
            self.assertEqual([r["source"] for r in rows], ["health", "runs", "companion", "dialogue", "runs"])
            self.assertIn("web_deadline_exceeded", rows[3]["text"])
            self.assertNotIn("SECRET_PRIVATE_QUESTION", out)
            self.assertNotIn("outside window", out)
            self.assertNotIn("unstamped", out)


if __name__ == "__main__":
    unittest.main()
