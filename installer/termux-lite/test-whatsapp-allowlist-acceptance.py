import importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('acceptance',Path(__file__).with_name('companion-acceptance.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class AcceptanceScopeTests(unittest.TestCase):
 def test_secrets_only_no_phone_redaction(self):
  # Base LEAK is secrets-only: an allowlist page with E.164 numbers must not trigger a rollback.
  self.assertIsNone(m.LEAK.search(json.dumps({'items':[{'e164':'+216123456789','name':'Owner written text'}]})))
  self.assertIsNotNone(m.LEAK.search(json.dumps({'items':[{'e164':'Bearer abcdefghijkl'}]})))
 def test_budget_routes_and_owner_guard_present(self):
  self.assertIn(('/whatsapp/allowlist',10.0),m.READS)
  self.assertIn(('/whatsapp/allowlist/history?limit=50',10.0),m.READS)
  self.assertIn(('POST','/whatsapp/allowlist'),m.OWNER_GUARDS)
if __name__=='__main__':unittest.main()
