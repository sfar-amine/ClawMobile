#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SPEC = importlib.util.spec_from_file_location('g2', Path(__file__).with_name('runtime-contract-report.py'))
g2 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(g2)

def manifest(cases):
    return {'schema': g2.SCHEMA, 'base': 'a' * 40, 'cases': cases}

def case(id='read', path='/v1/read', types=None, phase='active', method='GET'):
    return {'id': id, 'template': path, 'method': method, 'phase': phase, 'source': 'core@aaaaaaa', 'types': types or {}}

class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.requests = []
        cls.payload = {}
        cls.status = 200
        cls.delay = 0
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                cls.requests.append(('POST', self.path)); self.send_error(500)
            def do_GET(self):
                cls.requests.append(('GET', self.path))
                if self.path == '/v1':
                    body = {'endpoints': cls.inventory}; status = 200
                else:
                    body = cls.payload; status = cls.status; time.sleep(cls.delay)
                self.send_response(status)
                if status == 302: self.send_header('Location', '/v1/redirect-target')
                self.end_headers()
                try:self.wfile.write(json.dumps(body).encode())
                except (BrokenPipeError, ConnectionResetError):pass
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True);cls.thread.start()
        cls.base = 'http://127.0.0.1:'+str(cls.server.server_port)
    @classmethod
    def tearDownClass(cls):cls.server.shutdown();cls.server.server_close()
    def setUp(self):
        type(self).requests=[];type(self).payload={};type(self).status=200;type(self).delay=0;type(self).inventory=['/v1/read']
    def run_report(self, cases=None, bindings=None, timeout=1):
        return g2.report(self.base,manifest(cases or [case()]),bindings,timeout,fixture=True)
    def test_nullable_present_and_missing(self):
        type(self).payload={'receipt':None,'state':'ok'}
        r=self.run_report([case(types={'receipt':['object','null'],'state':'string'})]);self.assertTrue(r['fixtureReadChecksPassed']);self.assertFalse(r['complete'])
        r=self.run_report([case(types={'missing':['object','null']})]);self.assertFalse(r['complete'])
    def test_pending_offline_unknown_mandatory(self):
        cs=[case(),case('pending','/v1/new',phase='pending'),case('offline','/v1/effect',phase='offline',method='POST'),case('unknown','/v1/unknown',phase='unknown',method=None)]
        r=self.run_report(cs);self.assertFalse(r['complete']);self.assertEqual([x['attempts'] for x in r['cases']],[1,0,0,0]);self.assertTrue(all(m=='GET' for m,p in self.requests))
    def test_no_inventory_false_completeness(self):
        type(self).inventory=['/v1/read','/v1/new'];self.assertFalse(self.run_report()['complete'])
    def test_redirection_never_followed(self):
        type(self).status=302;r=self.run_report();self.assertEqual(r['cases'][0]['httpStatus'],302);self.assertNotIn(('GET','/v1/redirect-target'),self.requests)
    def test_timeout_and_http_error_never_retried(self):
        type(self).delay=.1;r=self.run_report(timeout=.02);self.assertEqual(r['cases'][0]['reason'],'transport_error_no_retry');self.assertEqual(self.requests.count(('GET','/v1/read')),1)
        type(self).delay=0;type(self).status=503;self.requests.clear();r=self.run_report();self.assertEqual(r['cases'][0]['reason'],'http_error');self.assertEqual(self.requests.count(('GET','/v1/read')),1)
    def test_secret_body_and_private_binding_never_exported(self):
        type(self).payload={'token':'DO-NOT-REPORT-ME','name':'PRIVATE-NAME'}
        r=self.run_report();text=json.dumps(r);self.assertNotIn('DO-NOT-REPORT-ME',text);self.assertNotIn('PRIVATE-NAME',text);self.assertEqual(r['cases'][0]['reason'],'secret_detected')
        type(self).payload={};type(self).inventory=['/v1/runs/:id']
        r=self.run_report([case(path='/v1/runs/:id')],{'read':{'params':{'id':'PRIVATE-RUN-ID'}}});self.assertNotIn('PRIVATE-RUN-ID',json.dumps(r))
    def test_unknown_fields_and_path_override_refused_before_io(self):
        for binding in [{'read':{'params':{},'template':'/v1/payments'}},{'absent':{'params':{}}},{'read':{'params':{'id':'../payments'}}}]:
            with self.assertRaises(g2.ContractError):self.run_report(bindings=binding)
        c=case();c['unknown']=True
        with self.assertRaises(g2.ContractError):self.run_report([c])
        self.assertEqual(self.requests,[])
    def test_loopback_and_sensitive_active_route_refused(self):
        for url in ['http://evil.example','http://localhost','http://127.0.0.1:0','http://user@localhost','http://127.0.0.1/x','http://127.0.0.1?x','file:///tmp/x']:
            with self.assertRaises(g2.ContractError):g2.base_url(url)
        for c in [case(path='/v1/payments'),case(method='POST'),case(path='/v1/read/../payments')]:
            with self.assertRaises(g2.ContractError):self.run_report([c])
    def test_receipt_idempotence_guard_shape_only_no_replay(self):
        op='fixture-operation'
        for state in ['indeterminate','running','waiting','failed','refused']:
            self.assertFalse(g2.replay_permitted({'success':True,'state':state,'receipt':{'operationId':op}},op))
        self.assertFalse(g2.replay_permitted({'success':True,'state':'completed','receipt':{'operationId':'other'}},op))
        type(self).payload={'success':True,'state':'completed','receipt':{'operationId':op}}
        r=self.run_report([case(types={'success':'boolean','state':'string','receipt.operationId':'string'})]);self.assertTrue(r['fixtureReadChecksPassed']);self.assertFalse(r['complete']);self.assertEqual(self.requests.count(('GET','/v1/read')),1)
        self.assertTrue(g2.replay_permitted(self.payload,op));self.assertFalse(r['mutationQualification'])
    def test_subset_never_qualifies_and_metadata_cannot_leak(self):
        with self.assertRaises(g2.ContractError):g2.report(self.base,manifest([case()]))
        for key,value in [('source','PRIVATE SECRET'),('reason','Bearer SECRET')]:
            c=case();c[key]=value
            with self.assertRaises(g2.ContractError):self.run_report([c])
        self.assertEqual(self.requests,[])
    def test_token_limits_are_not_secrets_and_real_github_tokens_are(self):
        type(self).payload={'maxTokens':8192,'max_tokens':4096,'usage':{'tokens':12}}
        self.assertTrue(self.run_report()['fixtureReadChecksPassed'])
        for value in ['ghp_'+'A'*36,'github_pat_'+'B'*40]:
            type(self).payload={'text':value}
            result=self.run_report();self.assertEqual(result['cases'][0]['reason'],'secret_detected');self.assertNotIn(value,json.dumps(result))
        type(self).payload={'accessToken':'private-credential'}
        self.assertEqual(self.run_report()['cases'][0]['reason'],'secret_detected')
    def test_default_timeouts_use_route_budgets_with_margin(self):
        calls=[]
        def fetch(opener,url,timeout):
            calls.append((url,timeout));return ({'endpoints':['/v1/agent/config','/v1/notifications/sources','/v1/read']} if url.endswith('/v1') else {},200,None,0)
        with patch.object(g2,'fetch_json',side_effect=fetch):
            result=g2.report(self.base,manifest([case('agent','/v1/agent/config'),case('notification','/v1/notifications/sources'),case()]),fixture=True)
        self.assertEqual([timeout for _,timeout in calls],[11,8,3,3]);self.assertTrue(result['fixtureReadChecksPassed']);self.assertFalse(result['complete'])
        self.assertEqual(g2.request_timeout('/v1/agent/config',.5),.5)
    def test_repository_manifest_closed(self):
        data=json.loads(Path(__file__).with_name('runtime-contract-cases.json').read_text());g2.validate_manifest(data)
        self.assertGreater(len(data['cases']),100)
        self.assertTrue(any(c['phase']=='pending' and c['source']=='core#36' for c in data['cases']))

if __name__=='__main__':unittest.main()
