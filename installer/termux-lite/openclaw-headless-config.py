#!/data/data/com.termux/files/usr/bin/python3
import json,os
from pathlib import Path
src=Path.home()/'.openclaw/openclaw.json'
dst=Path.home()/'.openclaw/headless/openclaw.json'
d=json.loads(src.read_text())
out={k:d[k] for k in ('models','agents','secrets') if k in d}
defs=out.setdefault('agents',{}).setdefault('defaults',{})
defs.pop('heartbeat',None)
defs.setdefault('modelPolicy',{})['allow']=['custom-po-zapro-su/gpt-5.6-luna']
out['plugins']={'enabled':False}
out['tools']={'profile':'coding','exec':{'mode':'full'},'codeMode':False}
dst.parent.mkdir(parents=True,exist_ok=True);dst.write_text(json.dumps(out,indent=2)+'\n');os.chmod(dst,0o600)
print(dst)
