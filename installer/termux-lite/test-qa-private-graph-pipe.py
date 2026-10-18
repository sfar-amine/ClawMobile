"""Exercise the real helper transport with independent decision/context pipes."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import io
from contextlib import redirect_stdout
from types import ModuleType
from unittest.mock import patch

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

    def test_multi_app_choice_is_revalidated_before_the_graph_private_pipe(self):
        package=ModuleType('qa_testing');scope=ModuleType('qa_testing.access_scope');intake=ModuleType('qa_testing.contact_input')
        context={'grants':[{'app_id':'one'},{'app_id':'two'}]}
        def validate(value):
            if 'selected_app_id' in value and value['selected_app_id'] not in {'one','two'}:raise ValueError()
            return value
        scope.validate_private_ingress=validate
        argv=['helper','--ui-root',str(self.root),'--surface','whatsapp','--dialogue','turn','neutral']
        original_path=list(sys.path)
        try:
            for selected in ('two','foreign'):
                intake.ingest_contact_input=lambda ctx,raw:{'state':'prepared','public_text':'Choix préparé.',
                    'selected_app_id':selected,'graph_text':'qa.test_campaign {"operation":"list"}'}
                def graph(message,**options):
                    self.assertNotIn('SYNTHETIC_PRIVATE_INPUT',message)
                    self.assertEqual(options['caller'],'trusted')
                    self.assertEqual(m._QA_INGRESS_CONTEXT['selected_app_id'],'two')
                    return {'outcome':'COMPLETED','handled':True}
                output=io.StringIO()
                with (patch.dict(sys.modules,{'qa_testing':package,'qa_testing.access_scope':scope,'qa_testing.contact_input':intake}),
                      patch.dict(os.environ,{'SAMANTHA_QA_INPUT_FD':'0'}),patch.object(sys,'argv',argv),
                      patch.object(m,'_read_qa_input',return_value={'context':context,'user_input':'SYNTHETIC_PRIVATE_INPUT'}),
                      patch.object(m,'run_dialogue',side_effect=graph) as runner,redirect_stdout(output)):
                    result=m.main()
                self.assertNotIn('SYNTHETIC_PRIVATE_INPUT',output.getvalue())
                self.assertEqual(result,0 if selected=='two' else 1)
                self.assertEqual(runner.call_count,1 if selected=='two' else 0)
        finally:sys.path[:]=original_path

if __name__=='__main__':unittest.main()
