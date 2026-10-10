#!/usr/bin/env python3
"""Local canonical voice producer → reader used by claw_context, no voice executor."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
SOURCE=Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('--playbooks-root',required=True);args=parser.parse_args()
reader_path=Path(args.playbooks_root)/'tools/request_context.py'
spec=importlib.util.spec_from_file_location('c5_claw_context_reader',reader_path)
reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(reader)
with tempfile.TemporaryDirectory(prefix='c5-voice-reader-') as directory:
 home=Path(directory);scripts=home/'scripts';scripts.mkdir()
 for source in SOURCE.glob('context*'):
  if source.is_file() and source.suffix in ('.sh','.py'):
   target=scripts/source.name;text=source.read_text()
   if source.suffix=='.sh':text='#!/usr/bin/env bash\n'+text.split('\n',1)[1]
   target.write_text(text);target.chmod(0o700)
 state=home/'.openclaw/context-sync';workspace=home/'.openclaw/workspace'
 for key in ['SOUL.md','AGENTS.md','context/OPERATING_RULES.md',reader.VOICE]:
  path=workspace/key;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('Mandatory fixture '+key)
 hybrid=workspace/reader.GLOBAL;hybrid.parent.mkdir(parents=True,exist_ok=True);hybrid.write_text('# Isolated mandatory foundation\n')
 env=dict(os.environ,SAMANTHA_CONTEXT_ROOT=str(state),SAMANTHA_HYBRID_PATH=str(hybrid))
 def event(text,*extra):
  run=subprocess.run(['bash',str(scripts/'context-event.sh'),'voice','decision',*extra,text],env=env,text=True,capture_output=True)
  assert run.returncode==0,run.returncode
  return run.stdout.strip()
 original=event('C5 explicit voice preference quiet mornings')
 before=reader.snapshot(home,'quiet mornings',None,surface='voice')
 assert any(row['id']==original and row['text']=='C5 explicit voice preference quiet mornings' for row in before['context']['events'])
 assert event('C5 explicit voice preference quiet mornings')==original
 with sqlite3.connect(state/'memory.db') as c:assert c.execute('SELECT COUNT(*) FROM events').fetchone()[0]==1
 replacement=event('C5 explicit voice preference quiet afternoons','--supersedes',original)
 after=reader.snapshot(home,'quiet',None,surface='voice')
 assert [row['id'] for row in after['context']['events']]==[replacement]
 assert after['context']['events'][0]['supersedes']==original
 assert event('C5 explicit voice preference quiet afternoons','--supersedes',original)==replacement
 delta=reader.snapshot(home,'quiet',1,surface='voice')
 assert [row['id'] for row in delta['context']['events']]==[replacement]
 assert after['read_only'] and not after['cursor_advanced']
print('C5 canonical voice producer → claw_context reader: original/replay/replacement/delta PASS; isolated owner integration, planned capability not executed')
