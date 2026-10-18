#!/usr/bin/env python3
"""F5.3: synthetic GET envelopes replay reported S24 metadata through the existing Web contract owner."""
import copy
import datetime as dt
import fcntl
import importlib.util
import json
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
CORE = HERE.parents[1]
spec = importlib.util.spec_from_file_location('acceptance', HERE / 'companion-acceptance.py')
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
FIXTURE = CORE / 'openclaw-plugin-mobile-ui/fixtures/foundations/s24-web-gesture-observations-20261018.json'

def millis(value):
    return int(dt.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()*1000)

class WebGestureRecipe(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home = pathlib.Path(self.tmp.name); self.pb = self.home/'playbooks'
        (self.pb/'skill_intelligence').mkdir(parents=True)
        # Explicit synthetic peer source; actual cross-repository parity is F1's integration check.
        (self.pb/'skill_intelligence/public_web.py').write_text('BUDGET_MS=20000\nSEARCH_BUDGET_MS=12000\n')
        self.capture = json.loads(FIXTURE.read_text()); self.observed = self.capture['runs'][0]
        self.now = millis(self.observed['endedAt'])+1000; self.calls=[]
        self.contract,self.validator=a.web_recipe_contract(CORE,self.pb)
        self.prepared={'preparedAtMs':millis(self.observed['acceptedAt'])-1000,'operation':'answer','sessionId':'session_test'}
        # Fields absent from the sanitized capture are synthetic, schema-checked test data, never a real receipt.
        quote=self.observed['web']['reportedClaim']['quote']
        self.web={'version':1,'operation':'answer','outcome':'complete','provider':'parallel-free','providerAuth':'anonymous',
            'model':self.observed['web']['model'],'profile':self.observed['web']['profile'],'responseLanguage':'fr',
            'metrics':self.observed['web']['metrics'],'error':None,'degradations':[],
            'sources':[{'id':'s4','title':'Synthetic schema fixture','url':'https://badinfluence.news/codex-reset',
                'searchRetrievedAt':'2026-10-18T09:05:23Z','publishedAt':None,'excerpt':quote,'evidenceType':'search_excerpt'}],
            'claims':[{'id':'c1','text':self.observed['web']['reportedClaim']['text'],'sourceIds':['s4'],
                'support':[{'sourceId':'s4','quote':quote}]}], 'citations':[{'claimId':'c1','sourceId':'s4'}]}
        self.run={'runId':self.observed['runId'],'clientRunId':'client_test','sessionId':'session_test','state':'done',
                  'submittedAt':millis(self.observed['acceptedAt']),'updatedAt':millis(self.observed['endedAt']),'web':self.web,
                  'prompt':'PRIVATE_REQUEST','result':'PRIVATE_DISPLAYED_REPLY'}
    def judge(self,run=None,prepared=None):
        return a.web_recipe_judgment(prepared or self.prepared,self.run if run is None else run,
                                    self.run['runId'],self.now,self.contract,self.validator)
    def reader(self,*args):
        self.calls.append(args);return 200,json.dumps(self.run).encode(),0.01
    def prepare(self,**kwargs):
        return a.web_recipe('prepare','session_test',CORE,self.pb,home=self.home,
            clock=lambda:self.prepared['preparedAtMs']/1000,**kwargs)[0]
    def exercise(self,receipt,**kwargs):
        return a.web_recipe('judge',None,CORE,self.pb,receipt['recipeId'],self.run['runId'],
                            home=self.home,clock=lambda:self.now/1000,reader=self.reader,**kwargs)
    def test_reported_answer_metadata_is_structurally_accepted_without_claiming_factual_truth(self):
        self.assertIn('Claude',self.capture['provenance']['captured_by'])
        self.assertFalse(self.capture['limits']['completeHttpEnvelopeCaptured'])
        result=self.judge();self.assertEqual(result['state'],'passed');self.assertEqual(result['metrics']['elapsedMs'],17000)
        self.assertEqual(result['sourceCount'],1) # synthetic envelope, not the capture's five sources
        self.assertNotIn('13 octobre',json.dumps(result));self.assertNotIn('PRIVATE',json.dumps(result))
    def test_real_search_observation_never_qualifies_as_an_answer(self):
        self.web.update(operation='search',claims=[],citations=[],model=None,profile=None)
        self.web['metrics']=self.capture['runs'][1]['web']['metrics']
        self.assertEqual(self.judge()['reason'],'web_operation_mismatch')
        prepared={**self.prepared,'operation':'search'}
        self.assertEqual(self.judge(prepared=prepared)['state'],'passed')
    def test_typed_failures_use_owner_schema_and_keep_their_code(self):
        old=json.loads((CORE/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-17/web-answer-synthesis.json').read_text())
        codes=[old['termux_node']['synthesis_result']['error']['code'],
               old['openclaw_config_shape']['synthesis_result']['error']['code']]
        for code in codes:
            with self.subTest(code=code):
                run=copy.deepcopy(self.run);run['state']='failed';run['web'].update(outcome='failed',
                    error={'code':code,'stage':'synthesis','message':'Synthetic owner-contract failure'})
                self.assertEqual(self.judge(run)['reason'],code)
    def test_prepare_precedes_gesture_judge_reads_only_one_explicit_run_and_receipt_is_private(self):
        prepared=self.prepare();self.assertEqual(prepared['state'],'prepared');self.assertEqual(self.calls,[])
        result,code=self.exercise(prepared);self.assertEqual(code,0);self.assertEqual(result['state'],'passed')
        self.assertEqual(self.calls,[('GET','/runs/'+self.run['runId'],dict(a.READS)['/runs?limit=50'])])
        receipt=self.home/'.openclaw/deploys'/prepared['receipt'];text=receipt.read_text()
        for private in ('PRIVATE','badinfluence','Last reset','13 octobre','Synthetic schema'):self.assertNotIn(private,text)
        self.assertEqual(receipt.stat().st_mode&0o777,0o600)
        stored=json.loads(text);self.assertLess(stored['preparedAtMs'],self.run['submittedAt'])
        self.assertEqual(stored['judgment']['clientRunId'],'client_test')
    def test_judgment_is_idempotent_and_cannot_switch_run(self):
        prepared=self.prepare();one=self.exercise(prepared);two=self.exercise(prepared)
        self.assertEqual(one[1],two[1]);self.assertEqual(len(self.calls),1)
        with self.assertRaisesRegex(ValueError,'web_recipe_already_judged'):
            a.web_recipe('judge',None,CORE,self.pb,prepared['recipeId'],'different_run',home=self.home)
    def test_wrong_run_session_or_client_is_never_admitted(self):
        for key,value in (('runId','other'),('sessionId','other'),('clientRunId',None)):
            run={**self.run,key:value};self.assertEqual(self.judge(run)['reason'],'web_run_identity_mismatch')
        prepared={**self.prepared,'clientRunId':'other'}
        self.assertEqual(self.judge(prepared=prepared)['reason'],'web_run_identity_mismatch')
    def test_old_future_and_nonterminal_run_are_rejected(self):
        for key,value in (('submittedAt',self.prepared['preparedAtMs']-1),('updatedAt',self.now+1),('submittedAt',True)):
            self.assertEqual(self.judge({**self.run,key:value})['reason'],'web_run_outside_prepared_window')
        self.assertEqual(self.judge({**self.run,'state':'running'})['reason'],'web_run_not_terminal')
    def test_total_search_and_missing_metric_budgets_fail_closed(self):
        late={**self.run,'submittedAt':self.now-21001,'updatedAt':self.now}
        self.assertEqual(self.judge(late,{**self.prepared,'preparedAtMs':late['submittedAt']-1})['reason'],'web_deadline_exceeded')
        for value,reason in ((12001,'web_deadline_exceeded'),(None,'web_timing_unavailable')):
            run=copy.deepcopy(self.run);run['web']['metrics']['searchMs']=value
            self.assertEqual(self.judge(run)['reason'],reason)
    def test_owner_validator_rejects_broken_sources_and_citations(self):
        run=copy.deepcopy(self.run);run['web']['citations'][0]['sourceId']='missing'
        self.assertEqual(self.judge(run)['reason'],'web_contract_invalid')
        self.assertEqual(self.judge({**self.run,'web':self.observed['web']})['reason'],'web_contract_invalid')
    def test_known_run_cause_survives_absent_web_proof(self):
        result=self.judge({**self.run,'web':None,'reasonClass':'transport_timeout'})
        self.assertEqual(result['reason'],'web_contract_invalid');self.assertEqual(result['reasonClass'],'transport_timeout')
    def test_budget_mismatch_change_and_missing_sources_refuse(self):
        prepared=self.prepare();owner=self.pb/'skill_intelligence/public_web.py'
        owner.write_text('BUDGET_MS=21000\nSEARCH_BUDGET_MS=12000\n')
        with self.assertRaisesRegex(ValueError,'web_budget_contract_differs'):self.exercise(prepared)
        owner.write_text('BUDGET_MS=20000\nSEARCH_BUDGET_MS=11000\n')
        with self.assertRaisesRegex(ValueError,'web_budget_contract_changed'):self.exercise(prepared)
        owner.unlink()
        with self.assertRaisesRegex(ValueError,'web_budget_contract_unavailable'):self.prepare()
    def test_receipts_are_bounded_and_other_owner_proofs_preserved(self):
        prepared=self.prepare();directory=self.home/'.openclaw/deploys'
        other=directory/'companion-proof.json';other.write_text('preserve')
        for n in range(35):
            row={**self.prepared,'version':1,'kind':'web_gesture_acceptance'}
            a.web_recipe_write(directory/('web-recipe-'+str(1000000000000+n)+'-'+'a'*16+'.json'),row)
        self.assertEqual(len(list(directory.glob('web-recipe-*.json'))),a.WEB_RECIPE_KEEP)
        self.assertEqual(other.read_text(),'preserve')
        outside=self.home/'outside';outside.write_text('private');link=directory/'web-recipe-link.json';link.symlink_to(outside)
        with self.assertRaisesRegex(ValueError,'web_recipe_invalid'):a.web_recipe_write(link,{})
        self.assertEqual(outside.read_text(),'private')
    def test_invalid_ids_and_conflicting_deployment_are_refused(self):
        with self.assertRaisesRegex(ValueError,'web_recipe_identity_invalid'):self.prepare(client_run_id='private@example.invalid')
        self.prepare();directory=self.home/'.openclaw/deploys'
        with open(directory/'companion-deploy.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError,'web_recipe_deployment_busy'):self.prepare()
    def test_http_failure_is_named_and_persisted_without_free_error(self):
        prepared=self.prepare();self.reader=lambda *args:(503,b'PRIVATE_PROVIDER_ERROR',0.01)
        result,code=self.exercise(prepared);self.assertEqual(code,1)
        self.assertEqual(result['judgment']['reason'],'web_run_http_unavailable');self.assertEqual(result['judgment']['httpStatus'],503)
        self.assertNotIn('PRIVATE',json.dumps(result))

if __name__=='__main__':unittest.main()
