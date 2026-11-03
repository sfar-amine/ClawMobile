#!/data/data/com.termux/files/usr/bin/python3
"""WhatsApp without an active listener (S24 28/10-02/11/2026).

Fixtures: openclaw-plugin-mobile-ui/fixtures/s24-2026-11-02-whatsapp-listener (real Gateway log, health
manager log and probe timings, cleaned). No network, no device, no real send: the Gateway CLI is a fake.
"""
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT.parents[1] / 'openclaw-plugin-mobile-ui/fixtures/s24-2026-11-02-whatsapp-listener'
CAPTURE = json.loads((FIXTURE / 'capture.json').read_text())
TIMELINE = (FIXTURE / 'gateway-whatsapp-timeline.log').read_text().splitlines()
HEALTH = (FIXTURE / 'health-whatsapp-20261102.log').read_text().splitlines()
TERMUX_BASH = '#!/data/data/com.termux/files/usr/bin/bash'
LOCAL = dt.timezone(dt.timedelta(hours=1))  # S24 local time (CET)

spec = importlib.util.spec_from_file_location('health_verdict_listener', ROOT / 'health-verdict.py')
HV = importlib.util.module_from_spec(spec)
spec.loader.exec_module(HV)

STATUS = CAPTURE['channels_status_probe']
CONNECTED, STOPPED, LOGGED_OUT = STATUS['status_line_connected'], STATUS['status_line_stopped'], STATUS['status_line_logged_out']
RUNNING_NOT_CONNECTED = '- WhatsApp default: enabled, configured, linked, running, disconnected, health:reconnecting'
# Real CLI JSON envelope (OpenClaw 2026.10.9 call-*.mjs) carrying the real Gateway error of 02/11 16:22:31 UTC.
GATEWAY_MESSAGE = next(l for l in TIMELINE if 'res ✗ send' in l).split('errorMessage=', 1)[1]
UNAVAILABLE_JSON = json.dumps({'ok': False, 'error': {'type': 'gateway_request_error', 'code': 'UNAVAILABLE',
                                                      'message': GATEWAY_MESSAGE, 'retryable': False}})


def utc(line):
    return dt.datetime.fromisoformat(line[:29])


def listener_gaps():
    """(start, end, cause) of every span without a WhatsApp listener in the Gateway log."""
    gaps, cur = [], None
    for line in TIMELINE:
        t, s = utc(line), line[30:]
        cause = None
        if 'Plugin whatsapp forced retirement' in s:
            cause = 'plugin_reload'
        elif 'Web watchdog is recovering' in s:
            cause = 'watchdog_499'
        elif 'Web connection closed (' in s:
            cause = 'close_' + re.search(r'status (\d+)', s).group(1)
        elif 'http server listening' in s:
            cause = 'gateway_start'
        if cause and cur is None:
            cur = (t, cause)
        elif 'Listening for WhatsApp inbound' in s and cur:
            gaps.append((cur[0], t, cur[1]))
            cur = None
    return gaps


class Fixtures(unittest.TestCase):
    def test_fixture_hashes_and_cleaning(self):
        prov = json.loads((FIXTURE / 'provenance.json').read_text())
        for name, digest in prov['files'].items():
            self.assertEqual(hashlib.sha256((FIXTURE / name).read_bytes()).hexdigest(), digest, name)
        for name in ('gateway-whatsapp-timeline.log', 'health-whatsapp-20261102.log', 'capture.json'):
            text = (FIXTURE / name).read_text()
            self.assertIsNone(re.search(r'\d{9,}', text), name)  # no phone number, no raw id
            self.assertNotIn('Sending message', text)
            self.assertNotIn('\x1b[', text)

    def test_real_listener_gaps_are_short(self):
        gaps = listener_gaps()
        d = sorted((b - a).total_seconds() for a, b, _ in gaps)
        stats = CAPTURE['listener_gaps_gateway_log']
        self.assertEqual(len(d), stats['gaps'])
        self.assertAlmostEqual(statistics.median(d), stats['median_s'], places=1)
        self.assertAlmostEqual(d[int(.9 * len(d)) - 1], stats['p90_s'], places=1)
        self.assertAlmostEqual(d[-1], stats['max_s'], places=1)
        causes = {}
        for *_, c in gaps:
            causes[c] = causes.get(c, 0) + 1
        self.assertEqual(causes, stats['by_cause'])
        # OpenClaw reconnected by itself every time; nothing in the covered log gave up.
        self.assertFalse(any('giving up' in l or 'Stopping web monitoring' in l for l in TIMELINE))

    def test_the_refused_send_fell_in_a_plugin_reload_gap(self):
        refused = utc(next(l for l in TIMELINE if 'res ✗ send' in l))
        hit = [(a, b, c) for a, b, c in listener_gaps() if a <= refused <= b]
        self.assertEqual(len(hit), 1)
        a, b, cause = hit[0]
        self.assertEqual(cause, 'plugin_reload')
        self.assertAlmostEqual((b - a).total_seconds(), 5.9, places=1)
        self.assertIn('No active WhatsApp Web listener', GATEWAY_MESSAGE)
        reload_line = next(l for l in TIMELINE if 'config change detected' in l)
        self.assertIn('agents.entries.main.tools', reload_line)

    def test_health_manager_incidents_were_false(self):
        # 02/11 16:11-20:01: four incidents opened, while no real listener gap reached the 120 s grace.
        opened = [l for l in HEALTH if 'action=incident_opened' in l]
        self.assertEqual(len(opened), 4)
        start = dt.datetime.fromisoformat(HEALTH[0].split()[0])
        end = dt.datetime.fromisoformat(HEALTH[-1].split()[0])
        real = [(a, b) for a, b, _ in listener_gaps() if start <= a <= end]
        self.assertEqual(len(real), 5)
        self.assertLess(max((b - a).total_seconds() for a, b in real), 120)


class Verdict(unittest.TestCase):
    def test_probe_budget_covers_measured_cli(self):
        self.assertGreaterEqual(HV.WHATSAPP_STATUS_TIMEOUT_S * 1000, max(STATUS['measured_ms']) + 3000)
        self.assertLess(STATUS['verdict_timeout_s_before'] * 1000, min(STATUS['measured_ms']))
        src = (ROOT / 'health-verdict.py').read_text()
        self.assertIn("run(f'timeout {WHATSAPP_STATUS_TIMEOUT_S} openclaw channels status'", src)
        self.assertNotIn("timeout 8 openclaw channels status", src)

    def test_states(self):
        self.assertEqual(HV.whatsapp_health(''), ('unverified', 'channel_status_unreadable'))
        self.assertEqual(HV.whatsapp_health('  \n'), ('unverified', 'channel_status_unreadable'))
        self.assertEqual(HV.whatsapp_health('Checking channel status…\nGateway reachable.\n' + CONNECTED), ('healthy', 'channel_connected'))
        self.assertEqual(HV.whatsapp_health(STOPPED), ('degraded', 'channel_stopped'))
        self.assertEqual(HV.whatsapp_health(LOGGED_OUT), ('degraded', 'terminal_auth_logout'))
        self.assertEqual(HV.whatsapp_health(RUNNING_NOT_CONNECTED), ('degraded', 'channel_not_connected'))
        self.assertEqual(HV.whatsapp_health('Checking channel status…\nGateway not reachable.'), ('degraded', 'channel_not_connected'))
        disabled = STOPPED.replace('enabled', 'disabled')
        self.assertEqual(HV.whatsapp_health(disabled), ('degraded', 'channel_not_connected'))

    def test_listener_gap_refusal_stops_degrading_after_five_minutes(self):
        failed_at = dt.datetime.fromisoformat('2026-11-02T17:22:32+01:00').timestamp()
        legacy = '2026-11-02T17:22:32+01:00 state=failed reason=gateway_call rc=1 elapsed_s=14 key=recovery-bc6233b9cb8d7d623f2f0840'
        gap = legacy.replace('reason=gateway_call', 'reason=listener_unavailable') + ''
        at_2009 = dt.datetime.fromisoformat('2026-11-02T20:09:35+01:00').timestamp()
        # Real 20:09 status (last channel send ~3 h ago, before the refusal): the legacy line still latches.
        self.assertEqual(HV.whatsapp_health(CONNECTED, legacy, now=at_2009), ('degraded', 'latest_outbound_failed'))
        self.assertEqual(HV.whatsapp_health(CONNECTED, gap, now=at_2009), ('healthy', 'channel_connected'))
        self.assertEqual(HV.whatsapp_health(CONNECTED, gap, now=failed_at + 60), ('degraded', 'latest_outbound_failed'))
        self.assertEqual(HV.whatsapp_health(CONNECTED, gap, now=failed_at + HV.LISTENER_GAP_EVIDENCE_S), ('healthy', 'channel_connected'))
        # Not connected: the refusal never hides anything.
        self.assertEqual(HV.whatsapp_health(STOPPED, gap, now=at_2009), ('degraded', 'channel_stopped'))


class HealthManager(unittest.TestCase):
    """Real check_whatsapp shell function, mocked clock, verdict, gate and Gateway CLI."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        (self.base / 'bin').mkdir()
        self.calls = self.base / 'gateway-calls'
        fake = self.base / 'bin/openclaw'
        fake.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$*" >>"$FAKE_CALLS"\n'
                        'if [ -n "${FAKE_START_JSON:-}" ]; then printf "%s\\n" "$FAKE_START_JSON"; else\n'
                        'printf "%s\\n" \'{"channel":"whatsapp","accountId":"default","started":true,"outcome":{"status":"fulfilled"}}\'; fi\n')
        fake.chmod(0o755)
        hm = (ROOT / 'samantha-health-manager.sh').read_text()
        self.prefix = hm.split("log 'event=start result=ok state=persistent_backoff'", 1)[0]

    def run_ticks(self, ticks, extra=''):
        """ticks: list of (now, state, reason). Returns (log lines, fail ticks, gateway calls)."""
        harness = ['''
verdict_field(){ if [ "$2" = state ]; then printf '%s\\n' "$MOCK_STATE"; else printf '%s\\n' "$MOCK_REASON"; fi; }
now(){ printf '%s\\n' "$MOCK_NOW"; }
log(){ printf '%s\\n' "$*" >>"$TEST_LOG"; }
healthy(){ put "$1" status healthy; put "$1" failures 0; put "$1" next 0; }
fail(){ printf '%s\\n' "$MOCK_NOW" >>"$TEST_FAIL_LOG"; put "$1" status degraded; put "$1" next $(( MOCK_NOW + 15 )); }
canonical_mode(){ printf '%s\\n' "${MOCK_MODE:-normal}"; }
proc(){ case "$1" in *companion*) [ "${MOCK_COMPANION:-1}" = 1 ];; *) return 1;; esac; }
immune_action(){
 case "$2" in
  bounded-stale-lock-quarantine) echo '{"state":"active_owner"}'; return "${MOCK_LOCK_RC:-20}";;
  bounded-channel-start) [ "${MOCK_GATE_RC:-0}" = 0 ] || return "$MOCK_GATE_RC"; shift 2; "$@";;
 esac
}
''' + extra]
        for t, st, reason in ticks:
            harness.append(f'MOCK_STATE={st} MOCK_REASON={reason} MOCK_NOW={t} check_whatsapp')
        harness.append('true')
        log, fails = self.base / 'log', self.base / 'fails'
        env = {**os.environ, 'HOME': str(self.base / 'home'), 'CLAW_RUNTIME_ROOT': str(ROOT),
               'TEST_LOG': str(log), 'TEST_FAIL_LOG': str(fails), 'FAKE_CALLS': str(self.calls),
               'PATH': str(self.base / 'bin') + os.pathsep + os.environ['PATH']}
        env.update(self.env_extra if hasattr(self, 'env_extra') else {})
        ran = subprocess.run(['bash'], input=self.prefix + '\n'.join(harness) + '\n', text=True,
                             capture_output=True, env=env, timeout=60)
        self.assertEqual(ran.returncode, 0, (ran.stdout, ran.stderr))
        read = lambda p: p.read_text().splitlines() if p.exists() else []
        return read(log), read(fails), read(self.calls)

    def test_unreadable_probe_never_opens_an_outage(self):
        ticks = [(1000 + 15 * i, 'unverified', 'channel_status_unreadable') for i in range(40)]
        log, fails, calls = self.run_ticks(ticks)
        self.assertEqual((log, fails, calls), ([], [], []))

    def test_replay_of_0211_flaps(self):
        # 02/11 16:11-20:01 local, one tick per 15 s. Ticks inside a real listener gap read the channel as
        # running but not connected; ticks the old probe misread are unreadable; others connected.
        start = dt.datetime.fromisoformat(HEALTH[0].split()[0]).timestamp()
        end = dt.datetime.fromisoformat(HEALTH[-1].split()[0]).timestamp()
        gaps = [(a.timestamp(), b.timestamp()) for a, b, _ in listener_gaps()]
        false = []
        for i, line in enumerate(HEALTH):
            if 'reason=channel_not_connected' in line:
                t0 = dt.datetime.fromisoformat(line.split()[0]).timestamp()
                t1 = next((dt.datetime.fromisoformat(l.split()[0]).timestamp() for l in HEALTH[i + 1:] if 'state=healthy' in l), end)
                false.append((t0, t1))
        ticks_new, ticks_old = [], []
        t = int(start)
        while t <= end:
            in_gap = any(a <= t <= b for a, b in gaps)
            misread = any(a <= t < b for a, b in false)
            if in_gap:
                ticks_new.append((t, 'degraded', 'channel_not_connected'))
            elif misread:
                ticks_new.append((t, 'unverified', 'channel_status_unreadable'))
            else:
                ticks_new.append((t, 'healthy', 'channel_connected'))
            ticks_old.append((t, 'degraded', 'channel_not_connected') if misread or in_gap else (t, 'healthy', 'channel_connected'))
            t += 15
        _, old_fails, _ = self.run_ticks(ticks_old)
        self.assertGreater(len(old_fails), 0)  # the old classification reaches the incident path
        self.tearDown_reset()
        log, fails, calls = self.run_ticks(ticks_new)
        self.assertEqual(fails, [])
        self.assertEqual(calls, [])

    def tearDown_reset(self):
        for p in (self.base / 'home', self.base / 'log', self.base / 'fails', self.calls):
            if p.is_dir():
                subprocess.run(['rm', '-rf', str(p)], check=True)
            elif p.exists():
                p.unlink()

    def test_unreadable_inside_a_real_outage_keeps_its_start(self):
        ticks = [(1000, 'degraded', 'channel_not_connected'), (1060, 'unverified', 'channel_status_unreadable'),
                 (1119, 'unverified', 'channel_status_unreadable'), (1200, 'unverified', 'channel_status_unreadable'),
                 (1215, 'degraded', 'channel_not_connected')]
        log, fails, calls = self.run_ticks(ticks)
        self.assertEqual(fails, ['1215'])  # no escalation on unreadable alone, no new grace afterwards
        self.assertEqual(calls, [])

    def test_stopped_channel_gets_one_safe_channels_start(self):
        ticks = [(1000, 'degraded', 'channel_stopped'), (1060, 'degraded', 'channel_stopped'),
                 (1120, 'degraded', 'channel_stopped'), (1125, 'degraded', 'channel_stopped')]
        log, fails, calls = self.run_ticks(ticks)
        self.assertEqual(len(calls), 1)
        self.assertIn('gateway call channels.start', calls[0])
        self.assertIn('"channel":"whatsapp","accountId":"default"', calls[0])
        self.assertIn('service=whatsapp action=channel_start rc=0 outcome=fulfilled', log)
        self.assertEqual(fails, ['1120'])  # paced and still escalates through the existing fail path

    def test_reconnecting_channel_is_left_to_openclaw(self):
        ticks = [(1000, 'degraded', 'channel_not_connected'), (1120, 'degraded', 'channel_not_connected')]
        log, fails, calls = self.run_ticks(ticks)
        self.assertEqual(calls, [])
        self.assertEqual(fails, ['1120'])

    def test_task_owned_outcome_is_logged(self):
        self.env_extra = {'FAKE_START_JSON': '{"channel":"whatsapp","accountId":"default","started":true,'
                                             '"outcome":{"status":"retry","reason":"task-owned"}}'}
        log, _, calls = self.run_ticks([(1000, 'degraded', 'channel_stopped'), (1120, 'degraded', 'channel_stopped')])
        self.assertEqual(len(calls), 1)
        self.assertIn('service=whatsapp action=channel_start rc=0 outcome=retry:task-owned', log)

    def test_no_start_during_deployment_or_gate_refusal(self):
        self.env_extra = {'MOCK_MODE': 'deployment'}
        log, fails, calls = self.run_ticks([(1000, 'degraded', 'channel_stopped'), (1120, 'degraded', 'channel_stopped')])
        self.assertEqual(calls, [])
        self.assertIn('service=whatsapp state=deployment action=skip_channel_start', log)
        self.tearDown_reset()
        self.env_extra = {'MOCK_GATE_RC': '75', 'MOCK_COMPANION': '1'}
        log, fails, calls = self.run_ticks([(1000, 'degraded', 'channel_stopped'), (1120, 'degraded', 'channel_stopped')])
        self.assertEqual(calls, [])
        self.assertIn('service=whatsapp state=ai_gate_refused action=wait_channel_start', log)
        self.tearDown_reset()
        self.env_extra = {'MOCK_GATE_RC': '75', 'MOCK_COMPANION': '0'}
        log, fails, calls = self.run_ticks([(1000, 'degraded', 'channel_stopped'), (1120, 'degraded', 'channel_stopped')])
        self.assertEqual(len(calls), 1)
        self.assertIn('service=whatsapp action=direct_repair reason=ai_gate_unreachable', log)

    def test_never_restarts_the_gateway_for_a_stopped_channel(self):
        hm = (ROOT / 'samantha-health-manager.sh').read_text()
        body = hm.split('whatsapp_channel_start(){', 1)[1].split('\n}\n', 1)[0]
        effect = hm.split('whatsapp_channel_start_effect(){', 1)[1].split('\n}\n', 1)[0]
        for text in (body, effect):
            self.assertNotIn('runtime/restart', text)
            self.assertNotIn('gateway restart', text)
            self.assertNotIn('channels.stop', text)
            self.assertNotIn('logout', text)


class OwnerSend(unittest.TestCase):
    """Real whatsapp-owner-send.sh, fake Gateway CLI replaying the real UNAVAILABLE refusal."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.home = base / 'home'
        (self.home / '.openclaw/health').mkdir(parents=True)
        (self.home / '.openclaw/openclaw.json').write_text('{"commands":{"ownerAllowFrom":["whatsapp:+21600000000"]}}')
        self.runtime = base / 'runtime'
        self.runtime.mkdir()
        for name in ('whatsapp-owner-send.sh', 'owner_notify_retry.py'):
            text = (ROOT / name).read_text()
            (self.runtime / name).write_text(text.replace(TERMUX_BASH, '#!/usr/bin/env bash', 1))
        self.bin = base / 'bin'
        self.bin.mkdir()
        self.calls = base / 'calls'
        (base / 'unavailable.json').write_text(UNAVAILABLE_JSON)
        fake = self.bin / 'openclaw'
        fake.write_text(f'#!{sys.executable}\n'
                        'import os,sys,time\n'
                        f'calls={str(self.calls)!r}\n'
                        'n=len(open(calls).read().splitlines()) if os.path.exists(calls) else 0\n'
                        'open(calls,"a").write(" ".join(sys.argv[1:4])+"\\n")\n'
                        'time.sleep(float(os.environ.get("FAKE_DELAY","0")))\n'
                        'if n < int(os.environ.get("FAKE_REFUSALS","0")):\n'
                        f'    print(open({str(base / "unavailable.json")!r}).read()); sys.exit(1)\n'
                        'if os.environ.get("FAKE_OTHER_ERROR"):\n'
                        '    print(\'{"ok":false,"error":{"type":"gateway_request_error","code":"INVALID_REQUEST","message":"bad","retryable":false}}\'); sys.exit(1)\n'
                        'print(\'{"messageId":"fake-mid","channel":"whatsapp"}\')\n')
        fake.chmod(0o755)
        self.ledger = self.home / '.openclaw/health/whatsapp-outbound.log'

    def send(self, key, **env):
        e = {**os.environ, 'HOME': str(self.home), 'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
             'WHATSAPP_OWNER_SEND_HOLD_PAUSE_S': '0', **{k: str(v) for k, v in env.items()}}
        started = time.monotonic()
        ran = subprocess.run(['bash', str(self.runtime / 'whatsapp-owner-send.sh'), 'private body', key],
                             env=e, text=True, capture_output=True, timeout=60)
        return ran, time.monotonic() - started

    def calls_made(self):
        return len(self.calls.read_text().splitlines()) if self.calls.exists() else 0

    def test_hold_turns_a_short_gap_into_a_delivery(self):
        ran, _ = self.send('incident-gap', FAKE_REFUSALS=2)
        self.assertEqual(ran.returncode, 0, ran.stderr)
        self.assertEqual(ran.stdout.strip(), 'fake-mid')
        self.assertEqual(self.calls_made(), 3)
        lines = self.ledger.read_text().splitlines()
        self.assertEqual(len(lines), 1)  # one ledger line per invocation
        self.assertRegex(lines[0], r' state=accepted elapsed_s=\d+ holds=2 key=incident-gap message_id=fake-mid$')
        text = self.ledger.read_text()
        self.assertNotIn('21600000000', text)
        self.assertNotIn('private body', text)
        self.assertNotIn('No active WhatsApp Web listener', text)

    def test_hold_is_bounded_by_the_callers_budget(self):
        # Each refusal costs 2 s here; with the default 17 s budget the last retry needs 8 s left.
        ran, took = self.send('incident-long', FAKE_REFUSALS=99, FAKE_DELAY=2, WHATSAPP_OWNER_SEND_HOLD_PAUSE_S=1)
        self.assertEqual(ran.returncode, 1)
        self.assertLess(took, 18)  # callers wrap the script in `timeout 18`
        lines = self.ledger.read_text().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertRegex(lines[0], r' state=failed reason=listener_unavailable rc=1 elapsed_s=\d+ holds=\d+ key=incident-long$')
        holds = int(re.search(r'holds=(\d+)', lines[0]).group(1))
        self.assertEqual(self.calls_made(), holds + 1)
        self.assertGreaterEqual(holds, 1)

    def test_slow_refusal_is_not_retried(self):
        # 02/11 17:22:32: the refusal came back after 14 s; no room left in the budget, so no second call.
        ran, _ = self.send('recovery-slow', FAKE_REFUSALS=1, FAKE_DELAY=2, WHATSAPP_OWNER_SEND_BUDGET_S=8)
        self.assertEqual(ran.returncode, 1)
        self.assertEqual(self.calls_made(), 1)
        self.assertIn('reason=listener_unavailable', self.ledger.read_text())

    def test_other_errors_are_not_retried(self):
        ran, _ = self.send('incident-other', FAKE_OTHER_ERROR=1)
        self.assertEqual(ran.returncode, 1)
        self.assertEqual(self.calls_made(), 1)
        self.assertRegex(self.ledger.read_text(), r'state=failed reason=gateway_call rc=1 elapsed_s=\d+ holds=0 key=incident-other')

    def test_failure_line_feeds_the_verdict_and_the_retry_policy(self):
        self.send('incident-gap2', FAKE_REFUSALS=99, WHATSAPP_OWNER_SEND_BUDGET_S=8)
        line = self.ledger.read_text().splitlines()[-1]
        failed_at = dt.datetime.fromisoformat(line.split()[0]).timestamp()
        self.assertEqual(HV.whatsapp_health(CONNECTED, line, now=failed_at + 10), ('degraded', 'latest_outbound_failed'))
        self.assertEqual(HV.whatsapp_health(CONNECTED, line, now=failed_at + 91), ('healthy', 'channel_connected'))
        ran, _ = self.send('incident-gap2')  # per-key policy still defers the next attempt (60 s)
        self.assertEqual(ran.returncode, 75)


if __name__ == '__main__':
    unittest.main(verbosity=1)
