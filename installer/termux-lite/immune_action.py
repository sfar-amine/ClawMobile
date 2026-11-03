"""Termux adapter to the pinned engineering admission owner; no model routing."""
import json
import os
from pathlib import Path
import subprocess
import sys


def gate(command, *args):
    ui=Path.home()/'.openclaw/runtime-ui-playbooks/current'
    if not (ui/'skill_intelligence/immune_intervention.py').is_file():
        return {'state':'waiting','reason':'ai_admission_not_installed'}
    env=dict(os.environ,PYTHONPATH=str(ui))
    try:
        p=subprocess.run([sys.executable,'-m','skill_intelligence.immune_intervention',command,*args],
                         env=env,cwd=ui,capture_output=True,text=True,timeout=110)
        return json.loads(p.stdout)
    except (OSError,ValueError,subprocess.TimeoutExpired):
        return {'state':'verification_required','reason':'ai_admission_unavailable'}


def run(component, operation, observation, callback):
    gate('observe',component)
    grant=gate('allow',component,operation,'--observation',json.dumps(observation,ensure_ascii=False))
    if grant.get('state')!='selected':
        return {'state':'deferred','reason':grant.get('reason') or 'ai_decision_required','actions':0}
    # An exception leaves effect_started durable; no missing ACK becomes a retry.
    result=callback()
    settled=gate('settle',json.dumps(grant),'0')
    if settled.get('state')!='verification_required':
        return {'state':'attention_required','reason':'effect_receipt_unavailable','actions':1}
    if isinstance(result,dict):
        if result.get('state') in {'healthy','recovered'}:gate('observe',component,'--healthy')
        elif result.get('state')=='failed':gate('observe',component)
    return result
