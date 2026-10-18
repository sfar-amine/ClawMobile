"""Private QA pipe contract fixtures: real local pipes/files, no contacts/network."""
import copy
from contextlib import nullcontext
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec=importlib.util.spec_from_file_location('qa_attachment_people',Path(__file__).with_name('people-trusted.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


def admission():
    context={'owner':False,'requester_hash':'a'*64,'transport_event_id':'b'*64,
             'thread_ref':'direct-fixture','selected_app_id':'demo'}
    return {'context':context,'run_id':'qa-fixture','selected_app_id':'demo','state':'DRAFT','plan_version':2}


class QaAttachmentPipeTests(unittest.TestCase):
    def frame_file(self,raw,**kwargs):
        with tempfile.TemporaryFile() as stream:
            stream.write(raw);stream.seek(0)
            return m.qa_attachment_frame(stream,**kwargs)

    def test_admission_exact_16k_json_is_read_from_file_without_content_echo(self):
        prefix=b'{"fixture":"';suffix=b'"}'
        raw=prefix+b'x'*(16384-len(prefix)-len(suffix))+suffix
        header,body=self.frame_file(raw)
        self.assertEqual(len(raw),16384);self.assertEqual(set(header),{'fixture'});self.assertIsNone(body)
        with self.assertRaises(ValueError):self.frame_file(raw+b' ')

    def test_consume_binary_requires_exact_length_and_closed_header(self):
        value={'admission':admission(),'metadata':{'size_bytes':5}}
        raw=json.dumps(value).encode()+b'\n'+b'\x00\xffabc'
        header,body=self.frame_file(raw,consume=True)
        self.assertEqual(body,b'\x00\xffabc');self.assertEqual(header,value)
        for candidate in (raw[:-1],raw+b'x',json.dumps({**value,'path':'PRIVATE_PATH'}).encode()+b'\n12345'):
            with self.subTest(size=len(candidate)),self.assertRaises(ValueError):self.frame_file(candidate,consume=True)

    def test_body_size_bound_boolean_and_oversized_headers_fail_before_owner(self):
        for size in (False,True,0,-1,20*1024*1024+1,'5'):
            with self.subTest(size=size),self.assertRaises(ValueError):
                self.frame_file(json.dumps({'admission':admission(),'metadata':{'size_bytes':size}}).encode()+b'\n',consume=True)
        with self.assertRaises(ValueError):self.frame_file(b' '*16385+b'\n',consume=True)
        with self.assertRaises((ValueError,UnicodeError)):self.frame_file(b'\xff',consume=False)

    def test_exact_20mib_content_is_accepted_as_bytes_without_file_path(self):
        content=b'x'*(20*1024*1024)
        raw=json.dumps({'admission':admission(),'metadata':{'size_bytes':len(content)}}).encode()+b'\n'+content
        header,received=self.frame_file(raw,consume=True)
        self.assertEqual(received,content);self.assertEqual(set(header),{'admission','metadata'})
        with self.assertRaises(ValueError):self.frame_file(raw+b'x',consume=True)

    def test_real_pipe_streams_binary_across_header_and_multiple_reads(self):
        content=bytes(range(256))*256
        raw=json.dumps({'admission':admission(),'metadata':{'size_bytes':len(content)}}).encode()+b'\n'+content
        reader,writer=os.pipe()
        def send():
            try:
                offset=0
                while offset<len(raw):offset+=os.write(writer,raw[offset:])
            finally:os.close(writer)
        producer=threading.Thread(target=send,daemon=True);producer.start()
        with os.fdopen(reader,'rb',buffering=0) as stream:
            header,received=m.qa_attachment_frame(stream,consume=True,deadline=time.monotonic()+2)
        producer.join(timeout=1)
        self.assertFalse(producer.is_alive());self.assertEqual(received,content)
        self.assertEqual(header['metadata']['size_bytes'],len(content))

    def test_real_open_pipe_deadline_refuses_incomplete_header_and_body(self):
        payloads=(b'{',json.dumps({'admission':admission(),'metadata':{'size_bytes':2}}).encode()+b'\nx',json.dumps({'admission':admission(),'metadata':{'size_bytes':2}}).encode()+b'\nxy')
        for payload in payloads:
            reader,writer=os.pipe()
            try:
                os.write(writer,payload)
                with os.fdopen(reader,'rb',buffering=0) as stream:
                    reader=None;started=time.monotonic()
                    with self.assertRaises(TimeoutError):m.qa_attachment_frame(stream,consume=True,deadline=started+0.025)
                    self.assertLess(time.monotonic()-started,1.0)
            finally:
                if reader is not None:os.close(reader)
                os.close(writer)

    def test_admission_rejects_changed_private_correlation_and_output_shape(self):
        baseline=admission();request={'context':copy.deepcopy(baseline['context']),'run_id':baseline['run_id']}
        for field in ('requester_hash','transport_event_id','thread_ref','selected_app_id','owner'):
            value=copy.deepcopy(baseline);value['context'][field]=True if field=='owner' else 'wrong'
            with patch.object(m,'qa_owner_read_lease',return_value=nullcontext()),patch.object(m,'qa_owner_module',return_value=SimpleNamespace(contact_attachment_admission=lambda *a,**k:value)):
                self.assertEqual(m.qa_attachment_admit(request),{'ok':False,'error':{'code':'qa_scope_unavailable'}})
        for value in ({**baseline,'raw_path':'PRIVATE_PATH'},{**baseline,'plan_version':True},{**baseline,'state':'READY'}):
            with patch.object(m,'qa_owner_read_lease',return_value=nullcontext()),patch.object(m,'qa_owner_module',return_value=SimpleNamespace(contact_attachment_admission=lambda *a,**k:value)):
                self.assertFalse(m.qa_attachment_admit(request)['ok'])

    def test_consume_exception_after_callback_is_unknown_and_never_replayed(self):
        calls=[]
        def callback(*args,**kwargs):
            calls.append(1);raise ValueError('PRIVATE_PATH PRIVATE_CONTENT')
        with patch.object(m,'qa_owner_read_lease',return_value=nullcontext()),patch.object(m,'qa_owner_module',return_value=SimpleNamespace(ingest_contact_attachment=callback)):
            result=m.qa_attachment_consume(admission(),{'size_bytes':1},b'x')
        self.assertEqual(calls,[1]);self.assertEqual(result,{'state':'unknown','reason':'qa_attachment_result_unknown'})
        self.assertNotIn('PRIVATE',json.dumps(result))
        with patch.object(m,'qa_owner_read_lease',side_effect=PermissionError('PRIVATE_PATH')):
            self.assertEqual(m.qa_attachment_consume(admission(),{},b'x'),{'state':'blocked','reason':'qa_attachment_unavailable'})

    def test_consume_closed_output_never_reflects_raw_reason_or_extra_fields(self):
        for supplied,expected in (({'state':'blocked','reason':'/PRIVATE_PATH'},'blocked'),({'state':'imported','path':'PRIVATE_PATH'},'unknown'),({'state':'retry','reason':'anything'},'unknown')):
            with patch.object(m,'qa_owner_read_lease',return_value=nullcontext()),patch.object(m,'qa_owner_module',return_value=SimpleNamespace(ingest_contact_attachment=lambda *a,**k:supplied)):
                result=m.qa_attachment_consume(admission(),{},b'x')
            self.assertEqual(result['state'],expected);self.assertNotIn('PRIVATE',json.dumps(result));self.assertNotIn('path',result)

    def test_expired_deadline_never_enters_owner_callback(self):
        for phase in ('before_lease','after_module_load'):
            entered=Mock(return_value={'state':'imported'})
            owner=SimpleNamespace(ingest_contact_attachment=entered)
            with patch.object(m.time,'monotonic',return_value=100) as clock:
                def load(name):
                    if phase=='after_module_load':clock.return_value=102
                    return owner
                with patch.object(m,'qa_owner_read_lease',return_value=nullcontext()),patch.object(m,'qa_owner_module',side_effect=load):
                    result=m.qa_attachment_consume(admission(),{},b'x',deadline=99 if phase=='before_lease' else 101)
            entered.assert_not_called()
            self.assertEqual(result['state'],'blocked')

    def test_deadline_after_entered_callback_is_unknown_not_safe_to_retry(self):
        with patch.object(m.time,'monotonic',return_value=100) as clock:
            def callback(*args,**kwargs):
                clock.return_value=102
                return {'state':'imported'}
            entered=Mock(side_effect=callback)
            with patch.object(m,'qa_owner_read_lease',return_value=nullcontext()),patch.object(m,'qa_owner_module',return_value=SimpleNamespace(ingest_contact_attachment=entered)):
                result=m.qa_attachment_consume(admission(),{},b'x',deadline=101)
        self.assertEqual(entered.call_count,1)
        self.assertEqual(result,{'state':'unknown','reason':'qa_attachment_result_unknown'})

    def test_read_admission_deadline_never_enters_callback_after_owner_loading(self):
        entered=Mock(return_value=admission())
        with patch.object(m.time,'monotonic',return_value=100) as clock:
            def load(name):
                clock.return_value=102
                return SimpleNamespace(contact_attachment_admission=entered)
            with patch.object(m,'qa_owner_read_lease',return_value=nullcontext()),patch.object(m,'qa_owner_module',side_effect=load):
                result=m.qa_attachment_admit({'context':admission()['context']},deadline=101)
        entered.assert_not_called();self.assertFalse(result['ok'])

    def test_cli_malformed_private_stdin_returns_only_closed_failure(self):
        for mode,raw in (('qa-attachment-admit',b'[]'),('qa-attachment-consume',b'{PRIVATE_PATH\nPRIVATE_CONTENT')):
            result=subprocess.run([sys.executable,str(m.__file__),mode],input=raw,capture_output=True,timeout=2)
            self.assertEqual(result.returncode,0);value=json.loads(result.stdout)
            self.assertNotIn('PRIVATE',result.stdout.decode());self.assertEqual(result.stderr,b'')
            self.assertEqual(value,{'state':'blocked','reason':'qa_attachment_invalid'} if mode.endswith('consume') else {'ok':False,'error':{'code':'qa_scope_unavailable'}})


if __name__=='__main__':unittest.main()
