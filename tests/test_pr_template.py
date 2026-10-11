"""Generated GitHub event payloads; no S24 or account capture."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('check_pr_template',Path(__file__).resolve().parents[1]/'tools/check_pr_template.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class PrTemplateTests(unittest.TestCase):
    def setUp(self):
        self.required=m.headings(m.TEMPLATE.read_text())
        self.body='\n\n'.join('## '+h+'\nExplanation.' for h in self.required)
    def run_event(self,event,now='2026-10-18T00:00:00Z',name='pull_request'):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'event.json';p.write_text(json.dumps(event))
            capture=io.StringIO()
            with contextlib.redirect_stdout(capture):
                code=m.main(['--event-path',str(p),'--event-name',name,'--now',now])
            return code,capture.getvalue()
    def test_exact_repository_sections(self):
        code,out=self.run_event({'pull_request':{'body':self.body}})
        self.assertEqual(code,0);self.assertEqual(json.loads(out)['state'],'valid')
        self.assertEqual(len(self.required),4)
        self.assertEqual(self.required[-1],"Retour arrière")
    def test_one_week_warning_then_failure_exact_boundary(self):
        event={'pull_request':{'body':'missing'}}
        code,out=self.run_event(event,'2026-10-17T23:59:59Z')
        self.assertEqual(code,0);self.assertIn('::warning::',out)
        code,out=self.run_event(event)
        self.assertEqual(code,1);self.assertIn('::error::',out)
        self.assertEqual(m.ENFORCE_AT-m.WARNING_START,dt.timedelta(days=7))
    def test_headers_inside_fence_or_comment_do_not_count(self):
        for body in ['```md\n'+self.body+'\n```','~~~\n'+self.body+'\n~~~','<!--\n'+self.body+'\n-->','```md\n```not-a-closing-fence\n'+self.body]:
            with self.subTest(body=body[:5]):
                self.assertEqual(self.run_event({'pull_request':{'body':body}})[0],1)
    def test_wrong_case_and_wrong_heading_level(self):
        for body in [self.body.lower(),self.body.replace('## ','### ')]:
            self.assertEqual(self.run_event({'pull_request':{'body':body}})[0],1)
    def test_payload_is_not_executed_or_printed(self):
        marker='PRIVATE_BODY_MARKER; $(touch /tmp/never-create-from-pr)'
        code,out=self.run_event({'pull_request':{'body':self.body+'\n'+marker}})
        self.assertEqual(code,0);self.assertNotIn(marker,out)
    def test_push_skips_without_interpreting_payload(self):
        code,out=self.run_event({'pull_request':{'body':23}},name='push')
        self.assertEqual(code,0);self.assertEqual(json.loads(out)['state'],'skipped')
    def test_absent_event_local_skips_but_pr_fails(self):
        for name,expected in [('push',0),('pull_request',1)]:
            capture=io.StringIO()
            with contextlib.redirect_stdout(capture):
                code=m.main(['--event-path','','--event-name',name,'--now','2026-10-18T00:00:00Z'])
            self.assertEqual(code,expected)
    def test_invalid_payload_and_oversize_fail(self):
        for event in [[],{}, {'pull_request':None},{'pull_request':{'body':42}}, {'pull_request':{'body':'x'*(m.MAX_BODY_CHARS+1)}}]:
            self.assertEqual(self.run_event(event)[0],1)
    def test_naive_clock_refused(self):
        with self.assertRaises(Exception):m.clock('2026-10-18T00:00:00')
    def test_ci_uses_safe_pull_request_no_extra_permissions(self):
        text=(m.TEMPLATE.parents[1]/'.github/workflows/ci.yml').read_text()
        self.assertNotIn('pull_request_target',text)
        self.assertNotIn('contents: write',text)
        self.assertIn('types: [opened, synchronize, reopened, edited, ready_for_review]',text)
        self.assertIn('python3 ../tools/check_pr_template.py',text)
        self.assertIn('python3 -m unittest discover -s ../tests -p test_pr_template.py',text)

if __name__=='__main__':unittest.main()
