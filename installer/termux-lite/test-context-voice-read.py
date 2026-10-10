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
parser=argparse.ArgumentParser();parser.add_argument('--playbooks-root');args=parser.parse_args()
reader=None
if args.playbooks_root:
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
 for key in ['SOUL.md','AGENTS.md','context/OPERATING_RULES.md','memory/voice/amine.md']:
  path=workspace/key;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('Mandatory fixture '+key)
 hybrid=workspace/'context/HYBRID_CONTEXT.md';hybrid.parent.mkdir(parents=True,exist_ok=True);hybrid.write_text('# Isolated mandatory foundation\n')
 env=dict(os.environ,SAMANTHA_CONTEXT_ROOT=str(state),SAMANTHA_HYBRID_PATH=str(hybrid))
 def event(text,*extra):
  run=subprocess.run(['bash',str(scripts/'context-event.sh'),'voice','decision',*extra,text],env=env,text=True,capture_output=True)
  assert run.returncode==0,run.returncode
  return run.stdout.strip()
 original=event('C5 explicit voice preference quiet mornings')
 if reader: before=reader.snapshot(home,'quiet mornings',None,surface='voice')
 if reader: assert any(row['id']==original and row['text']=='C5 explicit voice preference quiet mornings' for row in before['context']['events'])
 assert event('C5 explicit voice preference quiet mornings')==original
 with sqlite3.connect(state/'memory.db') as c:assert c.execute('SELECT COUNT(*) FROM events').fetchone()[0]==1
 replacement=event('C5 explicit voice preference quiet afternoons','--supersedes',original)
 if reader: after=reader.snapshot(home,'quiet',None,surface='voice')
 if reader: assert [row['id'] for row in after['context']['events']]==[replacement]
 if reader: assert after['context']['events'][0]['supersedes']==original
 assert event('C5 explicit voice preference quiet afternoons','--supersedes',original)==replacement
 fixture_path=SOURCE.parents[1]/'openclaw-plugin-mobile-ui/fixtures/canonical-owner-local/c5-voice-events.json'
 fixture=json.loads(fixture_path.read_text())
 import hashlib
 payload=json.dumps(fixture['events'],sort_keys=True,separators=(',',':')).encode()
 assert hashlib.sha256(payload).hexdigest()==fixture['_capture']['eventsSha256']
 with sqlite3.connect(state/'memory.db') as c:
  c.row_factory=sqlite3.Row
  rows=[dict(r) for r in c.execute('SELECT id,revision,kind,text,supersedes FROM events ORDER BY revision')]
 assert rows==fixture['events']
 if reader: delta=reader.snapshot(home,'quiet',1,surface='voice')
 if reader: assert [row['id'] for row in delta['context']['events']]==[replacement]
 if reader: assert after['read_only'] and not after['cursor_advanced']
print('C5 canonical owner transport PASS; '+('local bi-repo reader integration PASS' if reader else 'CI transport fixture verified; reader CI in playbooks35'))
