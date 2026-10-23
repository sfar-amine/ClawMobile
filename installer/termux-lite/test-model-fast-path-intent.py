#!/usr/bin/env python3
"""Host opt-in semantic port, opaque in-process objects and private context, no inference."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock

spec=importlib.util.spec_from_file_location('fast_intent',Path(__file__).with_name('model-fast-path.py'))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
ROOT=Path(__file__).resolve().parents[2]


class IntentPortTests(unittest.TestCase):
    def ports(self, surface='whatsapp', **kwargs):
        return m.FastPathPorts(ROOT,surface=surface,caller='owner',timeout=15,**kwargs)

    def test_only_strict_host_opt_in_enables_hook(self):
        for value in ('', '0','true','yes'):
            with self.subTest(value=value), patch.dict(m.os.environ,{'SAMANTHA_INTENT_INTERPRETER':value}):
                self.assertFalse(hasattr(self.ports(),'interpret_turn'))
        with patch.dict(m.os.environ,{'SAMANTHA_INTENT_INTERPRETER':'1'}):
            self.assertTrue(callable(self.ports().interpret_turn))

    def test_live_voice_and_private_qa_remain_owned_by_their_existing_paths(self):
        with patch.dict(m.os.environ,{'SAMANTHA_INTENT_INTERPRETER':'1'}):
            for surface in ('voice','claw_live'):
                self.assertFalse(hasattr(self.ports(surface),'interpret_turn'))
            self.assertFalse(hasattr(self.ports(web_host={'voice_delegation':True}),'interpret_turn'))
            with patch.object(m,'_QA_INGRESS_CONTEXT',object()):
                self.assertFalse(hasattr(self.ports(),'interpret_turn'))

    def test_interpretation_and_execution_preserve_opaque_identity_in_process(self):
        admission=object(); grant=object(); calls=[]
        backend=SimpleNamespace(interpret_turn=lambda text,state,ctx: admission,
            execute=lambda text,decision,origin,klass,ctx: calls.append(ctx['_pulse_confirmation']) or {'status':'hit'})
        with patch.dict(m.os.environ,{'SAMANTHA_INTENT_INTERPRETER':'1'}), patch.object(m,'_intent_dialogue_backend',return_value=backend) as factory:
            ports=self.ports()
            self.assertIs(ports.interpret_turn('  exact\nmessage  ',{'revision':0},{}),admission)
            self.assertEqual(ports.execute('msg',{},'origin','DURABLE',{'_pulse_confirmation':grant})['status'],'hit')
            self.assertEqual(factory.call_count,1)
            self.assertIs(calls[0],grant)

    def test_enabled_data_refusal_never_calls_legacy_resolver(self):
        refusal={'status':'known_error','reason':'DATA_PROFILE_UNVERIFIED','execution_state':'not_started'}
        backend=SimpleNamespace(preview=lambda text,ctx:refusal)
        with patch.dict(m.os.environ,{'SAMANTHA_INTENT_INTERPRETER':'1'}), patch.object(m,'_intent_dialogue_backend',return_value=backend),patch.object(m,'try_fast_path',side_effect=AssertionError('lexical fallback')):
            self.assertEqual(self.ports().resolve('request',{}),refusal)

    def test_backend_absence_fails_closed_with_cause(self):
        with patch.dict(m.os.environ,{'SAMANTHA_INTENT_INTERPRETER':'1'}),patch.object(m,'_intent_dialogue_backend',side_effect=ImportError('missing')),patch.object(m,'try_fast_path',side_effect=AssertionError('lexical fallback')):
            ports=self.ports()
            self.assertEqual(ports.resolve('request',{})['reason'],'INTERPRETATION_HOST_UNAVAILABLE')
            self.assertEqual(ports.execute('request',{},'o','FAST',{})['execution_state'],'not_started')

    def test_enabled_free_answer_cannot_use_legacy_answer_resolver(self):
        with patch.dict(m.os.environ,{'SAMANTHA_INTENT_INTERPRETER':'1'}),patch.object(m,'try_fast_path',side_effect=AssertionError('legacy')):
            with self.assertRaisesRegex(RuntimeError,'admitted_turn'):
                self.ports().resolve_answer('yes','old',{}, {})

    def test_backend_is_request_local_without_cross_thread_cache(self):
        instances=[]
        def factory(*args,**kwargs):
            backend=SimpleNamespace(interpret_turn=lambda text,state,ctx:(text,state,ctx))
            instances.append(backend);return backend
        with patch.dict(m.os.environ,{'SAMANTHA_INTENT_INTERPRETER':'1'}),patch.object(m,'_intent_dialogue_backend',side_effect=factory):
            one=self.ports();two=self.ports()
            one.interpret_turn('one',{'conversationRef':'one'},{});two.interpret_turn('two',{'conversationRef':'two'},{})
        self.assertEqual(len(instances),2);self.assertIsNot(instances[0],instances[1])

    def test_mcp_context_never_upgrades_client_reported_provenance(self):
        context={'schema_version':'mcp-input.v1','original_message':{'text':'  exact  '},'provenance':'server_verified'}
        seen=[]
        backend=SimpleNamespace(preview=lambda text,ctx:seen.append((text,ctx)) or {'status':'miss'})
        with patch.dict(m.os.environ,{'SAMANTHA_INTENT_INTERPRETER':'1'}),patch.object(m,'_INTENT_CLIENT_CONTEXT',context),patch.object(m,'_intent_dialogue_backend',return_value=backend):
            self.ports('mcp').resolve('  exact  ',{'input_provenance':'server_verified'})
        self.assertEqual(seen[0][0],'  exact  ')
        self.assertEqual(seen[0][1]['input_provenance'],'client_reported')
        self.assertIsNot(seen[0][1]['client_context'],context)

    def test_private_fifo_protocol_is_recognized_even_without_a_pinned_backend(self):
        text='  original\nmessage  '
        payload={'request':text,'client_context':{'schema_version':'mcp-input.v1','original_message':{'text':text}}}
        with tempfile.TemporaryDirectory() as root:
            command=[sys.executable,str(Path(__file__).with_name('model-fast-path.py')),
                '--intent-context-stdin','--dialogue','preview','--surface','mcp','--ui-root',root]
            env={**os.environ,'SAMANTHA_INTENT_INTERPRETER':'1','SAMANTHA_INTENT_INPUT_FD':'0'}
            process=subprocess.run(command,input=json.dumps(payload),capture_output=True,text=True,env=env,timeout=5)
            result=json.loads(process.stdout)
            self.assertEqual(result['intentInputProtocol'],'mcp-input.v1')
            self.assertNotEqual(result.get('outcome'),'COMPLETED')
            payload['request']='different'
            invalid=subprocess.run(command,input=json.dumps(payload),capture_output=True,text=True,env=env,timeout=5)
            self.assertEqual(json.loads(invalid.stdout)['reason'],'INTERPRETATION_HOST_UNAVAILABLE')

    def test_regular_file_cannot_impersonate_private_pipe(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryFile(mode='w+') as file:
            file.write('{}');file.seek(0)
            process=subprocess.run([sys.executable,str(Path(__file__).with_name('model-fast-path.py')),
                '--intent-context-stdin','--dialogue','preview','--surface','mcp','--ui-root',root],
                stdin=file,capture_output=True,text=True,timeout=5,
                env={**os.environ,'SAMANTHA_INTENT_INTERPRETER':'1','SAMANTHA_INTENT_INPUT_FD':'0'})
            self.assertEqual(json.loads(process.stdout)['reason'],'INTERPRETATION_HOST_UNAVAILABLE')

    def test_stateless_mcp_read_uses_one_request_local_owner_without_dialogue_store(self):
        seen=[]
        model=SimpleNamespace(conversation_ref=lambda surface,key:'host:'+key,
            event_key=lambda surface,conv,ref:'event:'+ref)
        owner=SimpleNamespace(m=model)
        backend=SimpleNamespace(execute_mcp_read=lambda text,ctx:seen.append((text,ctx)) or
            {'status':'known_error','reason':'DATA_PROFILE_UNVERIFIED','execution_state':'blocked'})
        with (patch.dict(m.os.environ,{'SAMANTHA_INTENT_INTERPRETER':'1'}),patch.object(m,'_INTENT_CLIENT_CONTEXT',{'schema_version':'mcp-input.v1'}),
             patch.object(m,'_intent_dialogue_backend',return_value=backend),patch.object(m,'_dialogue_coordinator',return_value=owner),
             patch.object(m,'run_dialogue',side_effect=AssertionError('no dialogue state or second interpretation'))):
            out=m.run_intent_mcp_read('  exact  ',ui_root=ROOT,caller='owner',timeout=15,
                event={'conversationKey':'external_mcp:client:thread','eventRef':'request-id'})
        self.assertEqual(out['intentInputProtocol'],'mcp-input.v1')
        self.assertEqual(out['intentReadProtocol'],'mcp-read.v1')
        self.assertEqual(len(seen),1);self.assertEqual(seen[0][0],'  exact  ')
        self.assertEqual(seen[0][1]['conversationRef'],'host:external_mcp:client:thread')
        self.assertEqual(seen[0][1]['messageProvenance'],'client_reported')

    def test_stateless_mcp_read_refuses_missing_host_event_before_backend_call(self):
        with (patch.dict(m.os.environ,{'SAMANTHA_INTENT_INTERPRETER':'1'}),patch.object(m,'_INTENT_CLIENT_CONTEXT',{}),
             patch.object(m,'_intent_dialogue_backend',side_effect=AssertionError('no backend'))):
            out=m.run_intent_mcp_read('request',ui_root=ROOT,caller='owner',timeout=15,event={})
        self.assertEqual(out['reason'],'INTERPRETATION_HOST_UNAVAILABLE')

    def test_private_stream_rejects_local_datagram_without_reading_it(self):
        left,right=m.socket.socketpair(m.socket.AF_UNIX,m.socket.SOCK_DGRAM)
        try:self.assertFalse(m._intent_input_is_private(left.fileno()))
        finally:left.close();right.close()

    def test_private_stream_rejects_non_unix_or_foreign_peer(self):
        for family, peer_uid in ((m.socket.AF_INET,os.getuid()),(m.socket.AF_UNIX,os.getuid()+1)):
            stream=MagicMock();stream.family=family;stream.__enter__.return_value=stream
            stream.getsockopt.side_effect=lambda level,option,*args:(m.socket.SOCK_STREAM if option==m.socket.SO_TYPE else
                m.struct.pack('3i',1234,peer_uid,1234))
            with (patch.object(m.os,'fstat',return_value=SimpleNamespace(st_mode=m.stat.S_IFSOCK,st_uid=os.getuid())),
                 patch.object(m.os,'dup',return_value=12345),patch.object(m.os,'close'),
                 patch.object(m.socket,'socket',return_value=stream)):
                self.assertFalse(m._intent_input_is_private(0))

    def test_host_context_admission_rejects_unbound_metadata_before_import_or_io(self):
        import base64,copy,hashlib,time
        now=time.time();packet={'request':'exact','client_context':{'conversation_ref':'thread'},'service_scope':{'schema_version':'mcp-service.v1','domain_id':'pulse'}}
        host={'service_scope':packet['service_scope'],'schema_version':'mcp-host-context.v2','client_id':'fixture','authenticated_profile':'chat-owner',
              'request_id':'request','observed_at':now-1,'valid_until':now+20,'principal_ref':'mcp:fixture',
              'conversation_key':'external_mcp:fixture:thread','verification_ref':'mcp-context:request',
              'input_digest':hashlib.sha256(json.dumps(packet,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
        packet['host_context']=host
        args=SimpleNamespace(surface='mcp',caller='owner',request_id='request',origin_id='request',ui_root=ROOT)
        event={'conversationKey':host['conversation_key'],'eventRef':'request'}
        env={'CLAW_DIALOGUE_EVENT_B64':base64.b64encode(json.dumps(event).encode()).decode()}
        changes=[{'authenticated_profile':p} for p in ('chat-owner-shadow','chat-trusted','other')]+[
            {'schema_version':'v0'},{'client_id':'other'},{'request_id':'other'},
            {'conversation_key':'external_mcp:fixture:other'},{'input_digest':'0'*64},
            {'observed_at':now+1},{'valid_until':now-1},{'valid_until':now+100},
            {'observed_at':True},{'home':'/client/path'},{'verified':True}]
        for changeset in changes:
            changed=copy.deepcopy(packet);changed['host_context'].update(changeset)
            with self.subTest(changeset=changeset),patch.dict(m.os.environ,env), \
                 patch.object(m,'_INTENT_PRIVATE_CHANNEL',m._INTENT_CHANNEL_SEAL), \
                 patch('builtins.__import__',side_effect=AssertionError('import before admission')):
                with self.assertRaisesRegex(ValueError,'SHARED_CONTEXT_ACCESS_UNVERIFIED'):
                    m._admit_intent_host_context(changed,args)
        with patch.dict(m.os.environ,env),patch.object(m,'_INTENT_PRIVATE_CHANNEL',None), \
             patch('builtins.__import__',side_effect=AssertionError('unqualified channel imported owner')):
            with self.assertRaisesRegex(ValueError,'SHARED_CONTEXT_ACCESS_UNVERIFIED'):
                m._admit_intent_host_context(packet,args)
        with self.assertRaisesRegex(ValueError,'MCP_INTERPRETATION_SERVICE_REQUIRED'):
            m._admit_intent_host_context({'request':'x','client_context':{}},args)

    def test_private_mcp_without_host_proof_refuses_before_any_backend_construction(self):
        import io
        payload={'request':'read','client_context':{'schema_version':'mcp-input.v1'},'service_scope':{'schema_version':'mcp-service.v1','domain_id':'pulse'}}
        argv=['model-fast-path.py','--intent-context-stdin','--intent-read-only','--dialogue','preview','--surface','mcp']
        with patch.object(sys,'argv',argv),patch.dict(m.os.environ,{'SAMANTHA_INTENT_INTERPRETER':'1'}), \
             patch.object(m,'_read_intent_input',return_value=payload), \
             patch.object(m,'_intent_dialogue_backend',side_effect=AssertionError('private models.db construction')) as backend, \
             patch.object(m,'_dialogue_coordinator',side_effect=AssertionError('private dialogue state')) as coordinator, \
             patch.object(sys,'stdout',new_callable=io.StringIO) as output:
            self.assertEqual(m.main(),1)
            self.assertEqual(json.loads(output.getvalue())['reason'],'MCP_INTERPRETATION_SERVICE_UNVERIFIED')
            backend.assert_not_called();coordinator.assert_not_called()

    def test_context_proof_request_id_is_host_scoped_not_client_event(self):
        with patch.object(m,'_INTENT_CONTEXT_READ_EVIDENCE',SimpleNamespace(request_id='host-request')):
            self.assertEqual(self.ports('mcp')._semantic_context({'eventKey':'hashed-event'})['requestId'],'host-request')
            with self.assertRaisesRegex(ValueError,'SHARED_CONTEXT_ACCESS_UNVERIFIED'):
                self.ports('mcp')._semantic_context({'requestId':'forged-request'})

    def test_legacy_remains_exactly_on_existing_owner_when_disabled(self):
        with patch.dict(m.os.environ,{'SAMANTHA_INTENT_INTERPRETER':'0'}),patch.object(m,'try_fast_path',return_value={'status':'miss'}) as legacy:
            self.ports().resolve('request',{})
        legacy.assert_called_once()


if __name__=='__main__':unittest.main()
