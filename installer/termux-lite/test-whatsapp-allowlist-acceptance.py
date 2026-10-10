import importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('acceptance',Path(__file__).with_name('companion-acceptance.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class AcceptanceScopeTests(unittest.TestCase):
 def test_secrets_only_no_phone_redaction(self):
  for route in ['/whatsapp/allowlist','/whatsapp/allowlist/history?limit=50','/health']:
   self.assertFalse(m.response_leaks(route,json.dumps({'items':[{'e164':'+216123456789','name':'Owner written text'}]}).encode()))
   self.assertTrue(m.response_leaks(route,json.dumps({'items':[{'e164':'Bearer abcdefghijkl'}]}).encode()))
 def test_budget_routes_present(self):
  self.assertIn(('/whatsapp/allowlist',10.0),m.READS)
  self.assertIn(('/whatsapp/allowlist/history?limit=50',10.0),m.READS)
if __name__=='__main__':unittest.main()
