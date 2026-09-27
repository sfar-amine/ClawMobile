#!/data/data/com.termux/files/usr/bin/python
import json,os,subprocess,tempfile
from pathlib import Path
R=Path(__file__).parent
# Exact regression scenario: stale offline transports coexist with canonical UP.
adb='List of devices attached\n127.0.0.1:41175 offline\n127.0.0.1:43497 offline\n127.0.0.1:5556 device\n'
rows=[x.split() for x in adb.splitlines()[1:] if x.strip()]
assert any(x[0]=='127.0.0.1:5556' and x[1]=='device' for x in rows)
with tempfile.TemporaryDirectory() as td:
 h=Path(td); base=h/'.openclaw'/'continuations';base.mkdir(parents=True)
 p=base/'retrieval-runs.json'
 p.write_text(json.dumps({'r1':{'state':'blocked','blocked_by':'device.adb','target':'x','intent':'i'},'r2':{'state':'blocked','blocked_by':'network','target':'y','intent':'j'}}))
 env={**os.environ,'HOME':td}
 subprocess.run(['python',str(R/'capability-recovered.py'),'device.adb'],env=env,check=True,capture_output=True,text=True)
 d=json.loads(p.read_text())
 assert d['r1']['state']=='resuming' and d['r1']['blocked_by'] is None
 assert d['r2']['state']=='blocked'
 assert 'device.adb' in (base/'resume-queue.jsonl').read_text()
assert 'capability-recovered.py\" device.adb' in (R/'adb-recovery-watchdog.sh').read_text()
assert 'capability-recovered.py\" device.adb' in (R/'samantha-health-manager.sh').read_text()
print('PASS')
