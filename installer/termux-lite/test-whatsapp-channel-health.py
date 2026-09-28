#!/data/data/com.termux/files/usr/bin/python3
import importlib.util, json, tempfile
from pathlib import Path

ROOT=Path(__file__).parent
spec=importlib.util.spec_from_file_location('health_verdict',ROOT/'health-verdict.py')
hv=importlib.util.module_from_spec(spec); spec.loader.exec_module(hv)

healthy='- WhatsApp default: enabled, configured, linked, running, connected, health:healthy'
terminal='- WhatsApp default: enabled, configured, linked, error:status=401 Unauthorized Stream Errored (conflict), stopped, health:logged-out'
stopped='- WhatsApp default: enabled, configured, linked, stopped, health:degraded'

assert hv.whatsapp_health(healthy)==('healthy','channel_connected')
assert hv.whatsapp_health(healthy,'state=failed')==('degraded','latest_outbound_failed')
assert hv.whatsapp_health(terminal)==('down','terminal_auth_logout')
assert hv.whatsapp_health(stopped)==('down','channel_not_connected')

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
assert 'check_http gateway http://127.0.0.1:18789/healthz' not in hm
assert 'incident-notify.sh" human_required' in hm
assert 'incident-email.sh" --probe' in hm
assert 'smtplib.SMTP_SSL' in email
assert 'server.starttls' in email
assert 'INCIDENT_EMAIL_MODE' in email
print('whatsapp-channel-health: PASS')

rd=(ROOT/'remote-desktop-watchdog.sh').read_text()
assert 'functional(){ alive; }' in rd
assert 'ready_since' in rd
assert 'tail -500' not in rd
assert 'functional_probe=v3_process_steady_startup_transport' in rd
print('remote-desktop-watchdog-v3: PASS')
