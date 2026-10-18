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

    def trace(self, home, *filters):
        return subprocess.run(['python3',str(HERE/'claw-trace.py'),'--since','2026-10-17T22:00:00Z',
                               '--until','2026-10-17T23:00:00Z','--no-app','--json',*filters],
                              env=dict(os.environ,HOME=str(home)),capture_output=True,text=True)

    def test_correlation_is_exact_named_and_intersects_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);logs=home/'.openclaw/health';logs.mkdir(parents=True)
            (logs/'companion.stderr.log').write_text(
                '2026-10-17T22:30:00Z execution warn runId=run_1 clientRunId=client_2 failed_code\n'
                '2026-10-17T22:31:00Z execution warn runId=run_10 different_code\n'
                '2026-10-17T22:32:00Z execution warn message_mentions_run_1\n'
                '2026-10-17T23:30:00Z execution warn runId=run_1 outside_window\n')
            (logs/'companion.stderr.log.1').write_text(
                '2026-10-17T22:29:00Z turnId=turn_3 runId=run_1 accepted_code\n')
            done=self.trace(home,'--run','run_1');self.assertEqual(done.returncode,0,done.stderr)
            rows=[json.loads(line) for line in done.stdout.splitlines()]
            self.assertEqual(len(rows),2);self.assertIn('accepted_code',rows[0]['text'])
            for bad in ('different_code','mentions','outside_window'):self.assertNotIn(bad,done.stdout)
            narrowed=self.trace(home,'--run','run_1','--client-run','client_2')
            self.assertEqual(len(narrowed.stdout.splitlines()),1)
            self.assertEqual(self.trace(home,'run_1').stdout,done.stdout)
            self.assertEqual(len(self.trace(home,'--turn','turn_3').stdout.splitlines()),1)

    def test_runs_use_real_s24_shapes_and_never_copy_free_errors(self):
        fixture=HERE.parents[1]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11c/hs5-runs-shapes.json'
        captured=json.loads(fixture.read_text());self.assertIn('S24',captured['provenance']['device'])
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);store=home/'.openclaw/clawmobile-companion';store.mkdir(parents=True)
            # Capture retained relative durations and presence only. Replay at the explicit synthetic test clock.
            base=1792276200000
            records=[]
            for record in captured['runs']:
                row=dict(record,acceptedAt=base,updatedAt=base+record['updatedAtOffsetMs'])
                row['error']='PRIVATE_ACCOUNT@example.invalid token=secret-private-value'
                row['userText']='PRIVATE_USER_TEXT'
                records.append(row)
            (store/'runs.json').write_text(json.dumps({'runs':records}))
            selected=records[0]['runId'];done=self.trace(home,'--run',selected)
            self.assertEqual(done.returncode,0,done.stderr)
            self.assertEqual(len(done.stdout.splitlines()),2)
            self.assertIn('runId='+selected,done.stdout)
            for other in records[1:]:self.assertNotIn(other['runId'],done.stdout)
            self.assertNotIn('PRIVATE',done.stdout);self.assertNotIn('secret-private-value',done.stdout)

    def test_canonical_maximum_id_is_searchable_and_oversize_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);logs=home/'.openclaw/health';logs.mkdir(parents=True)
            value='r'*160
            (logs/'companion.stderr.log').write_text(
                '2026-10-17T22:30:00Z runs error {"runId":"'+value+'"} submitted_run_failed\n'
                '2026-10-17T22:30:01Z runId='+value+'x different_code\n')
            done=self.trace(home,'--run',value)
            self.assertEqual(done.returncode,0,done.stderr)
            self.assertEqual(len(done.stdout.splitlines()),1)
            self.assertIn('submitted_run_failed',done.stdout)
            rejected=self.trace(home,'--run',value+'x')
            self.assertNotEqual(rejected.returncode,0)
            self.assertIn('invalid_trace_correlation',rejected.stderr)
            self.assertNotIn(value,rejected.stderr)

    def test_json_metadata_and_invalid_filter(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);logs=home/'.openclaw/health';logs.mkdir(parents=True)
            (logs/'companion.stderr.log').write_text(
                '2026-10-17T22:30:00Z {"runId":"run_1","event":"failed_code"}\n'
                '2026-10-17T22:30:01Z {"runId":"run_10","event":"other_code"}\n')
            self.assertEqual(len(self.trace(home,'--run','run_1').stdout.splitlines()),1)
            failed=self.trace(home,'--turn','private@example.invalid')
            self.assertNotEqual(failed.returncode,0)
            self.assertIn('invalid_trace_correlation',failed.stderr)
            self.assertNotIn('private@example.invalid',failed.stderr)

    def test_a_release_apk_is_read_through_its_voice_log(self):
        # run-as is refused on the optimized APK; the voice owner's logcat lines carry the dated cause.
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp); (home / ".openclaw").mkdir(); bin_dir = home / "bin"; bin_dir.mkdir()
            adb = bin_dir / "adb"
            adb.write_text("#!/bin/sh\n"
                           "case \"$*\" in\n"
                           "  *run-as*) echo 'run-as: package not debuggable: ai.samantha.android.dev' >&2; exit 1;;\n"
                           "  *logcat*) printf '%s\\n' '     1792314356.251  9986  9986 I SamanthaVoice: voice_start'"
                           " '     1792314366.471  9986  9986 W SamanthaVoice: voice_fail:voice_error_incomplete_reply:correlation:stale_ignored'"
                           " '     1792300000.000  9986  9986 I SamanthaVoice: outside window';;\n"
                           "esac\n")
            adb.chmod(0o755)
            env = dict(os.environ, HOME=str(home), TZ="Africa/Tunis", PATH=f"{bin_dir}:{os.environ['PATH']}")
            out = subprocess.run(["python3", str(HERE / "claw-trace.py"), "--since", "2026-10-18T10:05:00+01:00",
                                  "--until", "2026-10-18T10:07:00+01:00", "--json"],
                                 env=env, capture_output=True, text=True, check=True).stdout
            rows = [json.loads(line) for line in out.splitlines()]
            self.assertEqual([r["source"] for r in rows], ["app", "app"])
            self.assertIn("voice_start", rows[0]["text"])
            self.assertIn("correlation:stale_ignored", rows[1]["text"])
            self.assertNotIn("outside window", out)


if __name__ == "__main__":
    unittest.main()
