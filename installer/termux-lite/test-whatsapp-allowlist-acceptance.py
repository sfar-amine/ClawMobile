import importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('acceptance',Path(__file__).with_name('companion-acceptance.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class AcceptanceScopeTests(unittest.TestCase):
 def test_e164_only_list_item_field(self):
  body=json.dumps({'items':[{'e164':'+216123456789'}]}).encode()
  self.assertFalse(m.response_leaks('/whatsapp/allowlist',body))
  for route in ['/whatsapp/allowlist/history?limit=50','/health','/whatsapp/allowlist?other=1']:
   self.assertTrue(m.response_leaks(route,body))
  for body in [{'items':[{'e164':'+216123456789','name':'+216123456789'}]}, {'e164':'+216123456789'}, {'items':[{'e164':'Bearer abcdefghijkl'}]}]:
   self.assertTrue(m.response_leaks('/whatsapp/allowlist',json.dumps(body).encode()))
 def test_budget_routes_present(self):
  self.assertIn(('/whatsapp/allowlist',10.0),m.READS)
  self.assertIn(('/whatsapp/allowlist/history?limit=50',10.0),m.READS)
if __name__=='__main__':unittest.main()
