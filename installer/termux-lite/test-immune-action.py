#!/usr/bin/env python3
"""Real Termux adapters, synthetic admission ports and controlled effects only."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('immune_action_under_test',HERE/'immune_action.py')
admission=importlib.util.module_from_spec(spec);spec.loader.exec_module(admission)


class AdmissionTests(unittest.TestCase):
    def test_absent_admission_never_executes(self):
        with tempfile.TemporaryDirectory() as td,patch.object(admission.Path,'home',return_value=Path(td)):
            effects=[]
            out=admission.run('fixture','bounded-restore',{'state':'down'},lambda:effects.append('write'))
        self.assertEqual(effects,[]);self.assertEqual(out['actions'],0)

    def test_selected_owner_executes_then_ack_and_native_verification(self):
        events=[]
        def gate(command,*args):
            events.append(command)
            return {'state':'selected','run_id':'original','owner':'fixture'} if command=='allow' else {'state':'verification_required'}
        with patch.object(admission,'gate',side_effect=gate):
            out=admission.run('fixture','bounded-restore',{'state':'down'},
                lambda:events.append('native-effect') or {'state':'recovered'})
        self.assertEqual(out['state'],'recovered')
        self.assertEqual(events,['observe','allow','native-effect','settle','observe'])

    def test_exception_leaves_uncertain_effect_for_native_owner(self):
        calls=[]
        def gate(command,*args):calls.append(command);return {'state':'selected'}
        def interrupted():raise RuntimeError('controlled interruption')
        with patch.object(admission,'gate',side_effect=gate),self.assertRaises(RuntimeError):
            admission.run('fixture','bounded-restore',{},interrupted)
        self.assertNotIn('settle',calls)

    def test_shell_adapter_refuses_and_admits_without_command_from_model(self):
        with tempfile.TemporaryDirectory() as td:
            home=Path(td);script=home/'probe.sh';effect=home/'effect'
            # Explicit synthetic port; no production flag can bypass the gate.
            for selected in (False,True):
                script.write_text('. '+repr(str(HERE/'immune-action.sh'))+'\n'+
                    'immune_python(){ case "$1" in allow) '+
                    ("printf '%s\\n' '{\"state\":\"selected\",\"run_id\":\"original\"}'; return 0" if selected else 'return 75')+
                    ';; *) return 0;; esac; }\n'+
                    'immune_action fixture bounded-restore touch "$HOME/effect"\n')
                p=subprocess.run(['bash',str(script)],env=dict(os.environ,HOME=td),capture_output=True,text=True)
                self.assertEqual(p.returncode,0 if selected else 75)
                self.assertEqual(effect.exists(),selected)

    def test_shell_grant_tracks_callback_actor_not_command_substitution(self):
        with tempfile.TemporaryDirectory() as td:
            script=Path(td)/'actor.sh'
            script.write_text('. '+repr(str(HERE/'immune-action.sh'))+'\n'+
                'immune_python(){ if [ "$1" = allow ]; then printf "%s\\n" "$*" >"$HOME/allow-args"; '+
                'printf "%s\\n" \'{"state":"selected"}\'; fi; }\n'+
                'effect(){ printf "%s\\n" "$BASHPID" >"$HOME/callback-pid"; }\n'+
                '( printf "%s\\n" "$BASHPID" >"$HOME/expected-pid"; immune_action fixture restore effect ) & wait\n')
            result=subprocess.run(['bash',str(script)],env=dict(os.environ,HOME=td),capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            actor=(Path(td)/'expected-pid').read_text().strip()
            self.assertEqual((Path(td)/'callback-pid').read_text().strip(),actor)
            self.assertIn('--effect-owner-pid '+actor,(Path(td)/'allow-args').read_text())

    def test_all_existing_mutating_recovery_owners_keep_ai_boundary(self):
        required={
            'samantha-health-manager.sh':['immune_action "$1" bounded-http-service-restore','immune_action adb','immune_action sshd','immune_action slack_bridge','immune_action android_phantom_headroom','immune_action gateway_memory'],
            'samantha-root-guardian.sh':['immune_action "$name"'],
            'adb-recovery-watchdog.sh':['immune_action adb','immune_action device.adb.recovery_readiness'],
            'remote-desktop-control.py':["admission['run']('remote_desktop'"],
            'tier0-watchdog.py':["admission['run']('tier0'"],
        }
        for name,needles in required.items():
            source=(HERE/name).read_text()
            for needle in needles:self.assertIn(needle,source,name)

if __name__=='__main__':unittest.main()
