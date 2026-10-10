import contextlib,importlib.util,io,json,unittest
from pathlib import Path
from unittest.mock import patch
source=Path(__file__).resolve().parents[2]/'installer/termux-lite/companion-acceptance.py'
spec=importlib.util.spec_from_file_location('r11_acceptance',source);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def exercise(self,list_seconds=.01,metadata_seconds=.01,items=None):
  calls=[]
  def call(method,path,timeout,headers=None):
   calls.append((method,path,timeout,headers));self.assertIsNone(headers)
   if path=='/conversations?limit=50':return 200,json.dumps({'items':items if items is not None else [{'sessionId':'alpha'}]}).encode(),list_seconds
   if path=='/conversations/alpha/metadata':return 200,b'{"title":"Fixture","pinned":true}',metadata_seconds
   return 403,b'{}',.001
  out=io.StringIO()
  with patch.object(m,'READS',[('/conversations?limit=50',.3)]),patch.object(m,'call',side_effect=call),contextlib.redirect_stdout(out):code=m.main()
  return code,json.loads(out.getvalue()),calls
 def test_actual_list_and_metadata_budgets(self):
  code,out,calls=self.exercise();self.assertEqual(code,0);self.assertEqual([x['budget'] for x in out['checks'][:2]],[.3,10.]);self.assertEqual(calls[1][:2],('GET','/conversations/alpha/metadata'))
 def test_slow_list_and_metadata_fail(self):
  for listing,metadata in [(.4,.01),(.01,10.1)]:self.assertEqual(self.exercise(listing,metadata)[0],1)
 def test_no_real_session_is_unqualified(self):
  code,out,calls=self.exercise(items=[]);self.assertEqual(code,1);self.assertEqual(out['checks'][1]['status'],'unqualified');self.assertFalse(any('/metadata' in call[1] for call in calls))
if __name__=='__main__':unittest.main()
