#!/data/data/com.termux/files/usr/bin/python3
import importlib.util
import inspect
import io
import json
import pathlib
import tempfile
import threading
import time
import types
import unittest
import sys
from contextlib import redirect_stdout
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).with_name("claw-live.py")
spec = importlib.util.spec_from_file_location("claw_live_v2", MODULE_PATH)
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)

class Args:
    no_color = True
    only = None
    compact = False
    preview_chars = 160

class ClawLiveTests(unittest.TestCase):
    def test_scrub_secrets(self):
        value = m.scrub_text("token=abc123 password=secret OTP: 123456 card 4111 1111 1111 1111")
        self.assertNotIn("abc123", value)
        self.assertNotIn("secret", value)
        self.assertNotIn("123456", value)
        self.assertNotIn("4111 1111", value)
        self.assertGreaterEqual(value.count("<redacted>"), 4)

    def test_safe_obj_omits_write_content(self):
        obj = m.safe_obj({"path":"/tmp/x","content":"private payload","api_key":"xyz"})
        self.assertEqual(obj["content"], "<omitted 15 chars>")
        self.assertEqual(obj["api_key"], "<redacted>")

    def test_backend_tags(self):
        self.assertIn("ADB", m.command_backend_tags("adb -s 127.0.0.1:5556 shell getprop"))
        self.assertIn("SLACK", m.command_backend_tags("claw-slack-bridge.sh status"))
        self.assertEqual(m.command_backend_tags("printf ok"), [])

    def test_renderer_multitag(self):
        r = m.Renderer(Args())
        buf = io.StringIO()
        with redirect_stdout(buf):
            r.emit(m.Event(["TERMUX","CHAT","RDC"], "Conversation", "CMD", "$ printf ok", status="OK", metric="12ms"))
        out = buf.getvalue()
        self.assertIn("[TERMUX][CHAT][RDC]", out)
        self.assertIn("[Conversation]", out)
        self.assertIn("CMD", out)
        self.assertIn("OK", out)

    def test_slack_receipt_fallback_renders_slack(self):
        class Surface:
            def label(self):
                return "CHAT", "Conversation"

        renderer = m.Renderer(Args())
        stream = m.SlackBridgeStream(renderer, Surface())
        with tempfile.TemporaryDirectory() as td:
            receipt = pathlib.Path(td) / "r1.json"
            receipt.write_text(json.dumps({
                "requestId": "r1",
                "method": "exec_wait",
                "state": "completed",
                "startedAt": 1000,
                "completedAt": 1025,
                "result": {"command": "printf ok"},
            }))
            buf = io.StringIO()
            with redirect_stdout(buf):
                stream._emit_request_file(str(receipt))
            out = buf.getvalue()
            self.assertIn("[TERMUX][CHAT][SLACK]", out)
            self.assertIn("printf ok", out)

    def test_live_idle_notice_does_not_mask_real_activity(self):
        r = m.Renderer(Args())
        r.last_activity = 10.0
        original = m.time.monotonic
        m.time.monotonic = lambda: 100.0
        try:
            with redirect_stdout(io.StringIO()):
                r.emit(m.Event(["LIVE"], action="IDLE", detail="écoute active"))
            self.assertEqual(r.last_activity, 10.0)
            with redirect_stdout(io.StringIO()):
                r.emit(m.Event(["BRIDGE", "SLACK"], action="OK", detail="ping"))
            self.assertEqual(r.last_activity, 100.0)
        finally:
            m.time.monotonic = original
        self.assertEqual(m.ACTION_COLOR["IDLE"], "\033[90m")
        self.assertGreaterEqual(m.IDLE_NOTICE_AFTER_S, 30.0)
        self.assertGreaterEqual(m.IDLE_NOTICE_EVERY_S, 60.0)

    def test_renderer_bounds_long_detail(self):
        r = m.Renderer(Args())
        buf = io.StringIO()
        with redirect_stdout(buf):
            r.emit(m.Event(["TERMUX"], "Conversation", "CMD", "x" * 1200))
        out = buf.getvalue()
        self.assertIn("…", out)
        self.assertLess(len(out), 650)

    def test_terminal_fd_alive_detects_deleted_pty_even_when_isatty_is_false(self):
        with mock.patch.object(m.os, "isatty", return_value=False):
            with mock.patch.object(m.os, "readlink", return_value="/dev/pts/0 (deleted)"):
                self.assertFalse(m.terminal_fd_alive(1))
        with mock.patch.object(m.os, "readlink", return_value="/dev/pts/0"):
            self.assertTrue(m.terminal_fd_alive(1))
        with mock.patch.object(m.os, "readlink", return_value="/tmp/output.log (deleted)"):
            self.assertTrue(m.terminal_fd_alive(1))
        with mock.patch.object(m.os, "readlink", side_effect=OSError):
            self.assertFalse(m.terminal_fd_alive(1))

    def test_detached_owner_requires_claw_live_and_deleted_tty(self):
        claw = b"/data/data/com.termux/files/usr/bin/python3\0/data/data/com.termux/files/usr/bin/claw-live\0"
        other = b"/data/data/com.termux/files/usr/bin/python3\0/tmp/worker.py\0"
        self.assertTrue(m.detached_claw_live_owner(123, claw, "/dev/pts/0 (deleted)"))
        self.assertFalse(m.detached_claw_live_owner(123, claw, "/dev/pts/0"))
        self.assertFalse(m.detached_claw_live_owner(123, other, "/dev/pts/0 (deleted)"))

    def test_recover_detached_owner_uses_sigterm_and_reacquires_lock(self):
        handle = mock.Mock()
        handle.fileno.return_value = 3
        with mock.patch.object(m, "detached_claw_live_owner", return_value=True):
            with mock.patch.object(m.os, "kill") as kill:
                with mock.patch.object(m.fcntl, "flock") as flock:
                    self.assertTrue(m.recover_detached_lock_owner(handle, 123))
        kill.assert_called_once_with(123, m.signal.SIGTERM)
        flock.assert_called_once()

    def test_tail_lines_stops_promptly_without_new_data(self):
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / "events.log"
            path.write_text("")
            m.stop_event.clear()
            gen = m.tail_lines(path)
            done = threading.Event()
            outcome = []

            def consume():
                try:
                    next(gen)
                except StopIteration:
                    outcome.append("stopped")
                finally:
                    done.set()

            worker = threading.Thread(target=consume)
            worker.start()
            time.sleep(0.1)
            m.stop_event.set()
            self.assertTrue(done.wait(1.5))
            worker.join(timeout=0.2)
            self.assertEqual(outcome, ["stopped"])
            m.stop_event.clear()

    def test_tail_lines_reads_append_without_child_process(self):
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / "events.log"
            path.write_text("")
            m.stop_event.clear()
            gen = m.tail_lines(path)
            done = threading.Event()
            outcome = []

            def consume():
                try:
                    outcome.append(next(gen))
                finally:
                    done.set()

            with mock.patch.object(m.subprocess, "Popen", side_effect=AssertionError("tail_lines must stay in-process")):
                worker = threading.Thread(target=consume)
                worker.start()
                time.sleep(0.1)
                with path.open("a") as handle:
                    handle.write("hello\n")
                    handle.flush()
                self.assertTrue(done.wait(1.5))
                worker.join(timeout=0.2)
            gen.close()
            self.assertEqual(outcome, ["hello"])
            m.stop_event.clear()

    def test_performance_contracts(self):
        source = MODULE_PATH.read_text()
        self.assertIn("current_dir_stamp != dir_stamp", source)
        self.assertIn("MAX_RENDER_DETAIL = 420", source)
        self.assertIn("acquire_single_instance()", source)
        self.assertIn("--allow-multiple", source)
        self.assertIn("terminal_fd_alive", source)
        self.assertNotIn("subprocess.Popen", inspect.getsource(m.tail_lines))

    def test_permanent_snapshot_is_one_shot_and_detects_stale_runtime(self):
        rows = [
            (1, "openclaw-gateway"),
            (2, "spawn-broker/worker.js"),
            (3, "dist/companion/server.js"),
            (4, "/current/claw-slack-bridge.mjs"),
            (5, "desktop-commander/dist/index.js remote"),
            (6, "/current/samantha-root-guardian.sh"),
            (7, "tier0/bin/tier0-watchdog.py"),
            (8, "/current/samantha-health-manager.sh"),
            (9, "/current/incident-manager.sh"),
            (10, "/current/incident-orchestrator-worker.sh"),
            (11, "/current/adb-recovery-watchdog.sh"),
            (12, "/current/remote-desktop-watchdog.sh"),
            (13, "/usr/bin/claw-live"),
        ]
        events = m.permanent_service_events(rows=rows, current_root="/current")
        self.assertEqual(len(events), 4)
        immune = next(e for e in events if "IMMUNE" in e.tags)
        self.assertEqual(immune.action, "RUN")
        self.assertEqual(immune.status, "CURRENT")
        stale_rows = [(pid, args.replace("/current/incident-manager.sh", "/old/incident-manager.sh")) for pid, args in rows]
        stale = next(e for e in m.permanent_service_events(rows=stale_rows, current_root="/current") if "IMMUNE" in e.tags)
        self.assertEqual(stale.action, "WARN")
        self.assertIn("stale=incident", stale.detail)

    def test_openclaw_read_observation_is_deduped(self):
        r = m.Renderer(Args())
        stream = m.OpenClawStream(r, 160)
        block = {"name": "read", "arguments": {"path": "/tmp/state.json"}}
        buf = io.StringIO()
        with redirect_stdout(buf):
            stream.emit_tool("IMPROVE", "Autonomous Engineering", block)
            stream.emit_tool("IMPROVE", "Autonomous Engineering", block)
        out = buf.getvalue()
        self.assertEqual(out.count("TOOL"), 1)
        self.assertIn("read", out)

    def test_renderer_keeps_mutating_tool_events_visible(self):
        r = m.Renderer(Args())
        stream = m.OpenClawStream(r, 160)
        block = {"name": "write", "arguments": {"path": "/tmp/state.json", "content": "x"}}
        buf = io.StringIO()
        with redirect_stdout(buf):
            stream.emit_tool("IMPROVE", "Autonomous Engineering", block)
            stream.emit_tool("IMPROVE", "Autonomous Engineering", block)
        self.assertEqual(buf.getvalue().count("TOOL"), 2)

    def test_whatsapp_contact_resolution(self):
        with tempfile.TemporaryDirectory() as td:
            db = pathlib.Path(td)/"people.db"
            import sqlite3
            c=sqlite3.connect(db)
            c.executescript("create table people(person_id text,display_name text,active integer); create table phones(person_id text,e164 text);")
            c.execute("insert into people values('p','Contact Test',1)")
            c.execute("insert into phones values('p','+21600000000')")
            c.commit(); c.close()
            old=m.PEOPLE_DB; m.PEOPLE_DB=db
            try:
                resolver=m.PeopleResolver()
                self.assertEqual(resolver.name("+21600000000"), "Contact Test")
            finally:
                m.PEOPLE_DB=old

if __name__ == "__main__":
    unittest.main(verbosity=2)
