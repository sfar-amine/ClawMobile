#!/data/data/com.termux/files/usr/bin/python3
import importlib.util,os,tempfile,unittest
from pathlib import Path
P=Path(__file__).with_name("incident-orchestrator.py");spec=importlib.util.spec_from_file_location("io",P);io=importlib.util.module_from_spec(spec);spec.loader.exec_module(io)
class T(unittest.TestCase):
 def setUp(self): self.t=tempfile.TemporaryDirectory();io.DB=Path(self.t.name)/"x.db"
 def tearDown(self): self.t.cleanup()
 def test_dedupe(self):
  a=io.open_incident("adb","boot-1","watchdog","down");b=io.open_incident("adb","boot-1","health","down");self.assertEqual(a["id"],b["id"])
 def test_human_guard(self):
  a=io.open_incident("adb","boot-1","watchdog","down")
  with self.assertRaises(SystemExit):io.transition(a["id"],"human_required","watchdog","guess",False)
  r=io.transition(a["id"],"human_required","orchestrator","pairing UI requires user code",True);self.assertEqual(r["state"],"human_required")
 def test_recovery_path(self):
  a=io.open_incident("gateway","runtime","health","down");i=a["id"]
  last=None
  for st in ["deterministic_recovery","diagnosing","planning","repairing","verifying","recovered"]: last=io.transition(i,st,"test")
  self.assertEqual(io.show(i)["incident"]["state"],"recovered")
  self.assertEqual(last["learning_gate"]["state"],"skipped_noncanonical_db")
 def test_recurrence_after_recovery_opens_new_episode(self):
  a=io.open_incident("adb","boot-1","watchdog","down");i=a["id"]
  io.transition(i,"human_required","orchestrator","pairing required",True)
  io.recover_incident("adb","boot-1","health","canonical adb verified")
  b=io.open_incident("adb","boot-1","watchdog","down again")
  self.assertNotEqual(i,b["id"]);self.assertEqual(b["state"],"detected")
  self.assertEqual(io.open_incident("adb","boot-1","health","still down")["id"],b["id"])
  self.assertEqual(io.recover_incident("adb","boot-1","health","recovered again")["id"],b["id"])
 def test_terminal(self):
  a=io.open_incident("gateway","runtime","health","down");i=a["id"];io.transition(i,"failed","test")
  with self.assertRaises(SystemExit):io.transition(i,"diagnosing","test")
 def test_verified_recovery_after_failed_incident_opens_recovery_episode(self):
  a=io.open_incident("remote_desktop","runtime","watchdog","down");old=a["id"]
  io.transition(old,"failed","orchestrator","deterministic recovery exhausted")
  r=io.recover_incident("remote_desktop","runtime","watchdog","functional health verified")
  self.assertNotEqual(old,r["id"]);self.assertEqual(r["state"],"recovered")
  self.assertEqual(io.show(old)["incident"]["state"],"failed")
  kinds=[e["kind"] for e in io.show(r["id"])["events"]]
  self.assertIn("recovery_after_failed",kinds)
 def test_human_required_can_resume_to_recovered(self):
  a=io.open_incident("adb","boot-2","watchdog","down");i=a["id"]
  io.transition(i,"human_required","orchestrator","pairing required",True)
  r=io.recover_incident("adb","boot-2","health","canonical adb verified")
  self.assertEqual(r["state"],"recovered")
if __name__=="__main__":unittest.main()
