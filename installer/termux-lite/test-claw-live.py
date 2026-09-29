#!/data/data/com.termux/files/usr/bin/python3
import importlib.util
import io
import json
import pathlib
import tempfile
import types
import unittest
import sys
from contextlib import redirect_stdout

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
