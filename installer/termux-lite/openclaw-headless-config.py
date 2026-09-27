#!/data/data/com.termux/files/usr/bin/python3
import json, os
from pathlib import Path

src = Path.home() / '.openclaw/openclaw.json'
dst = Path.home() / '.openclaw/headless/openclaw.json'
d = json.loads(src.read_text())

out = {k: d[k] for k in ('models', 'agents', 'secrets') if k in d}
defs = out.setdefault('agents', {}).setdefault('defaults', {})
defs.pop('heartbeat', None)
defs['model'] = {
    'primary': 'openai/gpt-5.6-sol',
    'fallbacks': ['openai/gpt-5.6-luna'],
}
defs.setdefault('modelPolicy', {})['allow'] = [
    'openai/gpt-5.6-sol',
    'openai/gpt-5.6-luna',
]
engineering = out.get('agents', {}).get('entries', {}).get('engineering-lite')
if isinstance(engineering, dict):
    engineering['model'] = 'openai/gpt-5.6-luna'
    engineering.setdefault('modelPolicy', {})['allow'] = ['openai/gpt-5.6-luna']

# Headless embedded OpenAI requires the stock OpenAI provider plugin. Keep the
# surface minimal: do not materialize unrelated channel/tool plugins.
out['plugins'] = {
    'enabled': True,
    'allow': ['openai'],
    'entries': {'openai': {'enabled': True}},
}
out['tools'] = {'profile': 'coding', 'exec': {'mode': 'full'}, 'codeMode': False}

dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(json.dumps(out, indent=2) + '\n')
os.chmod(dst, 0o600)
print(dst)
