#!/data/data/com.termux/files/usr/bin/python3
import importlib.util, json, os, subprocess, tempfile
from pathlib import Path

ROOT=Path(__file__).parent
spec=importlib.util.spec_from_file_location('health_verdict',ROOT/'health-verdict.py')
hv=importlib.util.module_from_spec(spec); spec.loader.exec_module(hv)

healthy='- WhatsApp default: enabled, configured, linked, running, connected, health:healthy'
terminal='- WhatsApp default: enabled, configured, linked, error:status=401 Unauthorized Stream Errored (conflict), stopped, health:logged-out'
stopped='- WhatsApp default: enabled, configured, linked, stopped, health:degraded'

assert hv.whatsapp_health(healthy)==('healthy','channel_connected')
assert hv.whatsapp_health(healthy,'state=failed')==('degraded','latest_outbound_failed')
assert hv.whatsapp_health(terminal)==('degraded','terminal_auth_logout')
assert hv.whatsapp_health(stopped)==('degraded','channel_not_connected')
assert hv.item('healthy',probe_kind='liveness')['probe_kind']=='liveness'
assert hv.item('degraded',probe_kind='readiness')['probe_kind']=='readiness'
external=hv.external_readiness('down',reason='provider_unavailable')
assert external['state']=='degraded'
assert external['probe_kind']=='readiness'
assert external['dependency']=='external'
assert external['restart_allowed'] is False
try:
    hv.item('healthy',probe_kind='mixed')
    raise AssertionError('unknown probe kinds must fail closed')
except ValueError:
    pass

with tempfile.TemporaryDirectory() as td:
    td=Path(td); ev=td/'events.log'; probe=td/'smtp-probe.json'
    ev.write_text('x channel=email state=accepted\n'+'y channel=email state=failed\n')
    assert hv.smtp_health(probe,ev)[0:2]==('down','latest_delivery_failed')
    probe.write_text(json.dumps({'checked_at':hv.NOW,'state':'ready','reason':'probe_ok'}))
    assert hv.smtp_health(probe,ev)[0:2]==('ready','probe_ok')

hm=(ROOT/'samantha-health-manager.sh').read_text()
email=(ROOT/'incident-email.sh').read_text()
assert 'check_gateway' in hm
assert 'check_whatsapp' in hm
assert 'terminal_auth_logout' in hm
assert 'WHATSAPP_READINESS_GRACE_S=120' in hm
assert 'put whatsapp unready_since 0' in hm
assert 'incident=deferred grace_s=$WHATSAPP_READINESS_GRACE_S' in hm
assert hm.index('unavailable_for=$((tick-since))') < hm.index('if [ "$reason" = terminal_auth_logout ]')
assert 'check_http gateway http://127.0.0.1:18789/healthz' not in hm
assert 'incident-notify.sh" human_required' in hm
assert 'incident-email.sh" --probe' in hm
assert 'openclaw gateway restart' not in hm
assert 'http://127.0.0.1:8765/v1/runtime/restart' in hm
assert "owner=companion" in hm
assert 'recovery_restart_requested' in hm
assert 'smtplib.SMTP_SSL' in email
assert 'server.starttls' in email
assert 'INCIDENT_EMAIL_MODE' in email

# Exercise the real shell function with an injected clock. Two short outages
# separated by a healthy reading cannot accumulate into an incident; a single
# continuous outage enters escalation at exactly 120 seconds.
prefix=hm.split("log 'event=start result=ok state=persistent_backoff'",1)[0]
with tempfile.TemporaryDirectory() as td:
    td=Path(td); fail_log=td/'fail.log'
    harness=r'''
verdict_field(){ if [ "$2" = state ]; then printf '%s\n' "$MOCK_STATE"; else printf '%s\n' "$MOCK_REASON"; fi; }
now(){ printf '%s\n' "$MOCK_NOW"; }
log(){ :; }
healthy(){ put "$1" status healthy; put "$1" failures 0; put "$1" next 0; }
fail(){ printf '%s\n' "$MOCK_NOW" >>"$TEST_FAIL_LOG"; put "$1" status degraded; }
MOCK_STATE=degraded MOCK_REASON=latest_outbound_failed MOCK_NOW=1000 check_whatsapp
MOCK_STATE=degraded MOCK_REASON=latest_outbound_failed MOCK_NOW=1119 check_whatsapp
test ! -s "$TEST_FAIL_LOG"
MOCK_STATE=healthy MOCK_REASON=channel_connected MOCK_NOW=1120 check_whatsapp
test "$(get whatsapp unready_since 9)" = 0
MOCK_STATE=degraded MOCK_REASON=latest_outbound_failed MOCK_NOW=1130 check_whatsapp
MOCK_STATE=degraded MOCK_REASON=latest_outbound_failed MOCK_NOW=1249 check_whatsapp
test ! -s "$TEST_FAIL_LOG"
MOCK_STATE=degraded MOCK_REASON=latest_outbound_failed MOCK_NOW=1250 check_whatsapp
test "$(cat "$TEST_FAIL_LOG")" = 1250
test "$(get whatsapp unready_since 0)" = 1130
'''
    env={**os.environ,'HOME':str(td),'CLAW_RUNTIME_ROOT':str(ROOT),'TEST_FAIL_LOG':str(fail_log)}
    ran=subprocess.run(['bash'],input=prefix+harness,text=True,capture_output=True,env=env)
    assert ran.returncode==0,(ran.stdout,ran.stderr)
print('whatsapp-channel-health: PASS')
