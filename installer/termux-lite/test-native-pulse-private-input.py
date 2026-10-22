#!/usr/bin/env python3
"""C16 private IPC negative witnesses; never a backend, provider or phone."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

HELPER=Path(__file__).with_name('model-fast-path.py')

class NativePrivateInputTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);now=int(time.time()*1000)
        contact='wa-'+hashlib.sha256(b'+21610000000').hexdigest()[:16]
        key=f'pulse-room:contacts-pulse:{contact}:agent:contacts-pulse:whatsapp:direct:+21610000000'
        self.packet={'request':'  oui\n','admission':{'schema_version':'native-pulse.v1',
            'contact_id':contact,'conversation_key':key,'event_ref':'host-message',
            'observed_at':now,'valid_until':now+30000}}
        self.event={'surface':'pulse_room','conversationKey':key,'eventRef':'host-message','caller':'owner'}
        self.env={**os.environ,'HOME':str(self.root),'SAMANTHA_NATIVE_PULSE_FD':'0','SAMANTHA_INTENT_INTERPRETER':'1',
            'CLAW_DIALOGUE_EVENT_B64':base64.b64encode(json.dumps(self.event).encode()).decode(),
            'CLAW_DIALOGUE_POLICY_B64':base64.b64encode(b'{"scope":"pulse_room"}').decode()}
        self.argv=[sys.executable,str(HELPER),'--native-pulse-mode','execute','--dialogue','handoff',
            '--surface','whatsapp','--caller','owner','--goal-ref','goal','--ui-root',str(self.root/'missing'),'placeholder']

    def invoke(self,**kwargs):
        result=subprocess.run(self.argv,capture_output=True,text=True,env=self.env,timeout=5,**kwargs)
        self.assertEqual(result.returncode,1,result.stdout)
        self.assertEqual(json.loads(result.stdout)['reason'],'native_pulse_admission_required')
        self.assertFalse((self.root/'.openclaw').exists(),'refusal precedes any store/backend')

    def test_regular_file_never_impersonates_inherited_private_stream(self):
        with tempfile.TemporaryFile(mode='w+') as source:
            source.write(json.dumps(self.packet));source.seek(0);self.invoke(stdin=source)

    def test_missing_fd_and_public_confirmation_flags_refused(self):
        self.env.pop('SAMANTHA_NATIVE_PULSE_FD');self.invoke(input=json.dumps({'accepted':True,**self.packet}))

    def test_mcp_and_qa_cannot_enter_native_effect_port(self):
        for key in ('SAMANTHA_INTENT_INPUT_FD','SAMANTHA_QA_INPUT_FD','SAMANTHA_QA_CONTEXT_FD'):
            self.env[key]='0';self.invoke(input=json.dumps(self.packet));self.env.pop(key)

    def test_oversized_private_body_refused_before_owner_import(self):
        self.invoke(input=json.dumps({**self.packet,'padding':'x'*17000}))

    def test_body_shape_and_missing_pinned_owner_refused(self):
        self.invoke(input=json.dumps({'accepted':True,**self.packet}))
        self.invoke(input=json.dumps(self.packet))

if __name__=='__main__':unittest.main()
