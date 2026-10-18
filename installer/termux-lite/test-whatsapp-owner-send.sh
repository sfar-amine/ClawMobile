#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
. "$R/host_test_support.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home/.openclaw" "$T/bin"
cat >"$T/home/.openclaw/openclaw.json" <<'JSON'
{"commands":{"ownerAllowFrom":["whatsapp:+21611111111"]}}
JSON
cat >"$T/bin/openclaw" <<'SH'
#!/data/data/com.termux/files/usr/bin/bash
printf '%s\n' "$*" >"$HOME/call.args"
printf '%s\n' '{"runId":"test-key","messageId":"fake-message-id","channel":"whatsapp"}'
SH
chmod 700 "$T/bin/openclaw"
host_adapt_shebangs "$T/bin/openclaw"
HOME="$T/home" PATH="$T/bin:$PATH" bash "$R/whatsapp-owner-send.sh" "private test body" "test-key" >"$T/out"
grep -qx 'fake-message-id' "$T/out"
grep -q 'gateway call send' "$T/home/call.args"
grep -q '"idempotencyKey": "test-key"' "$T/home/call.args"
grep -q 'state=accepted' "$T/home/.openclaw/health/whatsapp-outbound.log"
! grep -q '21611111111' "$T/home/.openclaw/health/whatsapp-outbound.log"
! grep -q 'private test body' "$T/home/.openclaw/health/whatsapp-outbound.log"
echo 'whatsapp owner send: OK'

# Q13 private mode: same transport file delegates to the existing people owner.
# All owner implementations below are synthetic host fixtures, never a send.
mkdir -p "$T/private-owner"
cp "$R/whatsapp-owner-send.sh" "$T/private-owner/whatsapp-owner-send.sh"
cat >"$T/private-owner/people-trusted.py" <<'PY'
import hashlib,json,os,pathlib,sys,time
body=sys.stdin.buffer.read()
entry={'argv':sys.argv[1:],'payload_sha256':hashlib.sha256(body).hexdigest()}
with (pathlib.Path(os.environ['HOME'])/'private-invocations.jsonl').open('a') as f:f.write(json.dumps(entry)+'\n')
mode=json.loads(body).get('fixture_mode','accepted')
if mode=='large': print('PRIVATE_DO_NOT_RELAY'*400)
elif mode=='invalid': print('PRIVATE_DO_NOT_RELAY');sys.exit(9)
elif mode=='unknown': print(json.dumps({'state':'UNKNOWN','reason':'PRIVATE_DO_NOT_RELAY'}))
elif mode=='not_sent': print(json.dumps({'state':'NOT_SENT','reason':'PRIVATE_DO_NOT_RELAY'}))
elif mode=='timeout': time.sleep(60)
else: print(json.dumps({'state':'ACCEPTED','message_id':'opaque-fixture-receipt'}))
PY
HOME="$T/home" python3 - "$T/private-owner/whatsapp-owner-send.sh" <<'PY'
import json,os,pathlib,subprocess,sys,time
helper=sys.argv[1]
payload={'contact_ref':'canonical-fixture-contact','run_id':'qa-fixture','message':'PRIVATE_DO_NOT_RELAY','fixture_mode':'accepted'}

def invoke(body,args=(),timeout=25):
    result=subprocess.run(['bash',helper,'--qa-delivery-stdin',*args],input=body,capture_output=True,timeout=timeout)
    assert result.returncode==0,(result.returncode,result.stderr)
    assert b'PRIVATE_DO_NOT_RELAY' not in result.stdout+result.stderr
    assert b'canonical-fixture-contact' not in result.stdout+result.stderr
    return json.loads(result.stdout)

accepted=invoke(json.dumps(payload).encode())
assert accepted=={'state':'ACCEPTED','message_id':'opaque-fixture-receipt'},accepted
for mode,expected in [('unknown','UNKNOWN'),('not_sent','NOT_SENT'),('invalid','UNKNOWN'),('large','UNKNOWN')]:
    result=invoke(json.dumps({**payload,'fixture_mode':mode}).encode())
    assert result['state']==expected,(mode,result)
    assert 'message_id' not in result
before=(pathlib.Path(os.environ['HOME'])/'private-invocations.jsonl').read_text().splitlines()
for body,args in [(b'',()),(b'x'*65537,()),(b'{}',('forbidden-extra-arg',))]:
    result=invoke(body,args)
    assert result=={'state':'NOT_SENT','reason':'qa_delivery_input_invalid'},result
assert len((pathlib.Path(os.environ['HOME'])/'private-invocations.jsonl').read_text().splitlines())==len(before)
started=time.monotonic()
result=invoke(json.dumps({**payload,'fixture_mode':'timeout'}).encode())
assert result['state']=='UNKNOWN',result
assert 19<=time.monotonic()-started<24
rows=[json.loads(line) for line in (pathlib.Path(os.environ['HOME'])/'private-invocations.jsonl').read_text().splitlines()]
assert len(rows)==6,rows # Once per accepted input, never an automatic retry.
assert all(row['argv']==['qa-deliver','--request-stdin'] for row in rows)
print('whatsapp QA private delegation: 9/9 contracts OK')
PY
