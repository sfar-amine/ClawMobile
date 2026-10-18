"""Exercise the real helper transport with independent decision/context pipes."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('qa_model',Path(__file__).with_name('model-fast-path.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class PrivateGraphPipeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        package=self.root/'skill_intelligence';package.mkdir();(package/'__init__.py').write_text('')
        (package/'capability_graph.py').write_text("""import json,os,sys
fd=int(os.environ['SAMANTHA_QA_CONTEXT_FD'])
with os.fdopen(fd) as context_pipe: context=json.load(context_pipe)
decision=json.load(sys.stdin)
print(json.dumps({'context':context,'decision':decision,'argv':sys.argv[1:]}))
""")
        self.previous=m._QA_INGRESS_CONTEXT
        m._QA_INGRESS_CONTEXT={'requester_hash':'wa-0123456789abcdef','padding':'x'*12000}

    def tearDown(self):
        m._QA_INGRESS_CONTEXT=self.previous;self.tmp.cleanup()

    def test_context_and_prepared_decision_use_distinct_pipes(self):
        # Larger than a small platform pipe buffer: bounded transient writer must not deadlock.
        decision={'decisionId':'fixture-1','capability':'qa.test_campaign'}
        code,value,stderr=m._run_json([sys.executable,'-m','skill_intelligence.capability_graph','execute-decision','QA', '--decision-stdin'],
            cwd=self.root,env={**os.environ,'PYTHONPATH':str(self.root)},input_text=json.dumps(decision),timeout=3)
        self.assertEqual(code,0);self.assertEqual(stderr,'')
        self.assertEqual(value['decision'],decision);self.assertEqual(value['context'],m._QA_INGRESS_CONTEXT)
        self.assertNotIn('wa-0123456789abcdef',json.dumps(value['argv']))

    def test_scoped_helper_cannot_fall_through_to_another_executor(self):
        with self.assertRaisesRegex(RuntimeError,'qa_scope_unavailable'):
            m._run_json([sys.executable,'-c','raise SystemExit("must not run")'],cwd=self.root,timeout=1)

    def test_failed_spawn_releases_private_writer(self):
        with self.assertRaises(FileNotFoundError):
            m._run_json(['/definitely-absent/qa-test-python','-m','skill_intelligence.capability_graph'],cwd=self.root,timeout=1)

if __name__=='__main__':unittest.main()
