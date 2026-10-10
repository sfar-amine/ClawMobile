import contextlib,importlib.util,io,json,unittest
from pathlib import Path
from unittest.mock import patch
source=Path(__file__).resolve().parents[2]/'installer/termux-lite/companion-acceptance.py'
spec=importlib.util.spec_from_file_location('r11_acceptance',source);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def exercise(self,list_seconds=.01,metadata_seconds=.01,items=None,session_id=None):
  calls=[]
  def call(method,path,timeout,headers=None):
   calls.append((method,path,timeout,headers));self.assertIsNone(headers)
   if path=='/conversations?limit=50':return 200,json.dumps({'items':items if items is not None else [{'sessionId':'alpha'}]}).encode(),list_seconds
   if path=='/conversations/alpha/metadata':return 200,b'{"title":"Fixture","pinned":true}',metadata_seconds
   return 403,b'{}',.001
  out=io.StringIO()
  with patch.object(m,'READS',[('/conversations?limit=50',.3)]),patch.object(m,'call',side_effect=call),contextlib.redirect_stdout(out):code=m.main(session_id)
  return code,json.loads(out.getvalue()),calls
 def test_actual_list_and_metadata_budgets(self):
  code,out,calls=self.exercise();self.assertEqual(code,0);self.assertEqual([x['budget'] for x in out['checks'][:2]],[.3,6.]);self.assertEqual(calls[1][:2],('GET','/conversations/alpha/metadata'))
 def test_supplied_session_is_probed_before_any_other_read(self):
  code,out,calls=self.exercise(session_id='alpha');self.assertEqual(code,0);self.assertEqual(calls[0][:2],('GET','/conversations/alpha/metadata'));self.assertEqual(calls[1][:2],('GET','/conversations/alpha/metadata'));self.assertEqual([x['budget'] for x in out['checks'][:2]],[6.,1.5]);self.assertEqual(calls[2][:2],('GET','/conversations?limit=50'));self.assertTrue(any(x['route']=='POST /conversations/x/metadata (no owner header)' and x['code']==403 for x in out['checks']))
 def test_invalid_supplied_session_has_no_io(self):
  with patch.object(m,'call') as call:self.assertEqual(m.main('../invalid'),2);call.assert_not_called()
 def test_slow_list_and_metadata_fail(self):
  for listing,metadata in [(.4,.01),(.01,6.1),(.01,1.6)]:self.assertEqual(self.exercise(listing,metadata)[0],1)
 def test_no_real_session_is_unqualified(self):
  code,out,calls=self.exercise(items=[]);self.assertEqual(code,1);self.assertEqual(out['checks'][1]['status'],'unqualified');self.assertFalse(any(call[0]=='GET' and '/metadata' in call[1] for call in calls))
if __name__=='__main__':unittest.main()
