#!/data/data/com.termux/files/usr/bin/python3
"""Bounded owner WhatsApp notification retries (S24 02/11/2026 retry storm).

Fixtures: openclaw-plugin-mobile-ui/fixtures/s24-2026-11-02-owner-notify-retry
(real whatsapp-outbound.log lines, message ids replaced). No network, no device.
"""
import datetime as dt
import hashlib
import importlib.util
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT.parents[1] / 'openclaw-plugin-mobile-ui/fixtures/s24-2026-11-02-owner-notify-retry'
LEDGER = FIXTURE / 'whatsapp-outbound-cleaned.log'
TERMUX_BASH = '#!/data/data/com.termux/files/usr/bin/bash'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('owner_notify_retry', 'owner_notify_retry.py')
HV = load('health_verdict_owner_delivery', 'health-verdict.py')
LINES = LEDGER.read_text().splitlines()
F73 = 'incident-f73a069c49edd4cf'
NEVER = 'incident-1fc6c7a375679b3a'
REPEATED = 'incident-25c564165b64d057'
RECOVERY = 'recovery-bc6233b9cb8d7d623f2f0840'


def iso(epoch):
    return dt.datetime.fromtimestamp(epoch).astimezone().isoformat(timespec='seconds')


def simulate_outage(key, start, end):
    """Replay a real outage window through the policy: every attempt in it fails."""
    entries, t, sends = [], start, 0
    while t <= end:
        action, detail = P.decide(entries, t)
        if action == 'send':
            sends += 1
            entries.append((t, 'failed', key, None))
            t += 10  # the incident manager loop wakes every 10 s
        elif action == 'deferred':
            t = max(detail, t + 10)
        else:
            return sends, action, t
    return sends, 'outage_over', t


class FixtureTests(unittest.TestCase):
    def test_fixture_is_clean_and_complete(self):
        self.assertEqual(hashlib.sha256(LEDGER.read_bytes()).hexdigest(),
                         json.loads((FIXTURE / 'provenance.json').read_text())['files']['whatsapp-outbound-cleaned.log'])
        rows = [P.parse_line(line) for line in LINES]
        self.assertEqual(len(rows), 191)
        self.assertTrue(all(rows))
        for line in LINES:
            self.assertNotRegex(line, r'\+?216\d{8}|@s\.whatsapp|@lid')
        summary = json.loads((FIXTURE / 'capture.json').read_text())['outbound_log_summary']
        self.assertEqual((summary['failed_lines'], summary['failed_distinct_keys'], summary['failed_keys_later_accepted'],
                          summary['failed_keys_never_accepted'], summary['accepted_distinct_keys']), (2138, 26, 10, 16, 95))

    def test_real_cadence_was_an_unbounded_five_minute_loop(self):
        failed = [row[0] for row in P.entries_for(LINES, F73) if row[1] == 'failed']
        gaps = [b - a for a, b in zip(failed[3:], failed[4:])]
        self.assertTrue(280 <= statistics.median(gaps) <= 320, statistics.median(gaps))
        self.assertEqual(len(P.entries_for(LINES, NEVER)), 109)


class PolicyTests(unittest.TestCase):
    def test_backoff_schedule(self):
        self.assertEqual([P.backoff_s(n) for n in range(0, 9)], [0, 60, 120, 240, 480, 960, 1800, 1800, 1800])
        self.assertEqual(P.backoff_s(200), 1800)

    def test_retry_is_deferred_until_backoff_elapsed(self):
        t0 = 1_800_000_000
        entries = [(t0, 'failed', 'k', None)]
        self.assertEqual(P.decide(entries, t0 + 59), ('deferred', t0 + 60))
        self.assertEqual(P.decide(entries, t0 + 60), ('send', ''))
        entries.append((t0 + 60, 'failed', 'k', None))
        self.assertEqual(P.decide(entries, t0 + 100), ('deferred', t0 + 180))

    def test_cap_on_attempts_and_age(self):
        t0 = 1_800_000_000
        twelve = [(t0 + i, 'failed', 'k', None) for i in range(12)]
        self.assertEqual(P.decide(twelve, t0 + 10_000)[0], 'exhausted')
        self.assertEqual(P.decide(twelve[:1], t0 + 86_400)[0], 'exhausted')
        self.assertEqual(P.decide(twelve[:1], t0 + 86_399)[0], 'send')

    def test_real_outages_are_bounded_to_twelve_attempts(self):
        for key, real in ((F73, 979), (NEVER, 109)):
            failed = [row[0] for row in P.entries_for(LINES, key) if row[1] == 'failed']
            # f73a's real outage lasted until the 02/11 acceptance; 1fc6 until its last failure.
            end = max(row[0] for row in P.entries_for(LINES, key))
            sends, outcome, at = simulate_outage(key, failed[0], end)
            self.assertEqual((sends, outcome), (12, 'exhausted'), key)
            self.assertLess(at - failed[0], 86_400)
            self.assertGreater(real, sends)

    def test_never_resend_after_accepted(self):
        for key in (REPEATED, RECOVERY, F73):
            entries = P.entries_for(LINES, key)
            last_mid = [row[3] for row in entries if row[1] == 'accepted'][-1]
            for now in (entries[-1][0] + 1, entries[-1][0] + 10 * 86_400):
                self.assertEqual(P.decide(entries, now), ('accepted', last_mid), key)
        # recovery-bc62 ends with a failure after 8 acceptances: still never re-sent.
        self.assertEqual(P.entries_for(LINES, RECOVERY)[-1][1], 'failed')

    def test_terminal_state_recorded_once_then_no_send(self):
        with tempfile.TemporaryDirectory() as td:
            ledger = Path(td) / 'whatsapp-outbound.log'
            ledger.write_text('\n'.join(l for l in LINES if f'key={NEVER}' in l) + '\n')
            before = len(ledger.read_text().splitlines())
            self.assertEqual(P.gate(ledger, NEVER), 'undeliverable recorded')
            self.assertEqual(P.gate(ledger, NEVER), 'undeliverable')
            self.assertEqual(P.after_failure(ledger, NEVER), 'state=undeliverable')
            text = ledger.read_text().splitlines()
            self.assertEqual(len(text), before + 1)
            self.assertRegex(text[-1], r'^\S+ state=undeliverable attempts=109 first_failed=2026-10-21T\S+ key=' + NEVER + '$')
            self.assertEqual(P.recent_undeliverable(text, time.time()), [NEVER])
            self.assertEqual(P.recent_undeliverable(text, time.time() + 86_401), [])


class HealthVisibilityTests(unittest.TestCase):
    def test_owner_delivery_row(self):
        now = time.time()
        line = f'{iso(now - 3600)} state=undeliverable attempts=12 first_failed={iso(now - 20000)} key={NEVER}'
        row = HV.owner_delivery_health(LINES + [line], now=now)
        self.assertEqual((row['state'], row['critical'], row['undeliverable_24h'], row['keys']),
                         ('degraded', False, 1, [NEVER]))
        self.assertTrue(row['reason'].startswith('notification_undeliverable'))
        old = HV.owner_delivery_health(LINES + [line], now=now + 86_400)
        self.assertEqual((old['state'], old['undeliverable_24h']), ('healthy', 0))
        # The bookkeeping line never replaces the latest real send attempt.
        self.assertEqual(HV.latest_send_attempt(LINES + [line]), LINES[-1])
        hm = (ROOT / 'samantha-health-manager.sh').read_text()
        self.assertNotIn('notification.owner_delivery', hm)


class Runtime(unittest.TestCase):
    """Real scripts in a temporary runtime with fake Gateway / transports."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.home = base / 'home'
        (self.home / '.openclaw/health').mkdir(parents=True)
        (self.home / '.openclaw/openclaw.json').write_text('{"commands":{"ownerAllowFrom":["whatsapp:+21600000000"]}}')
        self.runtime = base / 'runtime'
        self.runtime.mkdir()
        self.bin = base / 'bin'
        self.bin.mkdir()
        for name in ('whatsapp-owner-send.sh', 'incident-manager.sh', 'incident-notify.sh', 'incident-close.sh'):
            self.copy(name)
        shutil.copy(ROOT / 'owner_notify_retry.py', self.runtime / 'owner_notify_retry.py')
        self.ledger = self.home / '.openclaw/health/whatsapp-outbound.log'
        self.calls = base / 'gateway-calls'
        fake = self.bin / 'openclaw'
        fake.write_text(f'#!{sys.executable}\n'
                        'import os,sys\n'
                        f'open({str(self.calls)!r},"a").write(sys.argv[-1][-60:]+"\\n")\n'
                        'rc=int(os.environ.get("FAKE_GATEWAY_RC","0"))\n'
                        'print(\'{"messageId":"fake-mid","channel":"whatsapp"}\') if rc==0 else None\n'
                        'sys.exit(rc)\n')
        fake.chmod(0o755)
        self.env = {**os.environ, 'HOME': str(self.home), 'CLAW_RUNTIME_ROOT': str(self.runtime),
                    'PATH': str(self.bin) + os.pathsep + os.environ['PATH']}

    def copy(self, name):
        target = self.runtime / name
        target.write_text((ROOT / name).read_text().replace(TERMUX_BASH, '#!/usr/bin/env bash', 1))
        target.chmod(0o755)

    def write(self, name, text):
        target = self.runtime / name
        target.write_text(text)
        target.chmod(0o755)

    def send(self, key, rc=0):
        return subprocess.run(['bash', str(self.runtime / 'whatsapp-owner-send.sh'), 'private body', key],
                              env={**self.env, 'FAKE_GATEWAY_RC': str(rc)}, text=True, capture_output=True, timeout=30)

    def gateway_calls(self):
        return len(self.calls.read_text().splitlines()) if self.calls.exists() else 0


class SendScriptTests(Runtime):
    def test_accepted_key_is_never_sent_again(self):
        self.ledger.write_text('\n'.join(l for l in LINES if f'key={REPEATED}' in l) + '\n')
        result = self.send(REPEATED)
        self.assertEqual((result.returncode, self.gateway_calls()), (0, 0))
        mid = [l for l in LINES if f'key={REPEATED}' in l and 'accepted' in l][-1].split('message_id=')[1]
        self.assertEqual(result.stdout.strip(), mid)
        first = self.send('fresh-key')
        self.assertEqual((first.returncode, first.stdout.strip(), self.gateway_calls()), (0, 'fake-mid', 1))
        again = self.send('fresh-key')
        self.assertEqual((again.returncode, again.stdout.strip(), self.gateway_calls()), (0, 'fake-mid', 1))

    def test_failure_backoff_then_terminal_without_send(self):
        first = self.send('k1', rc=1)
        self.assertEqual(first.returncode, 1)
        self.assertRegex(first.stdout.strip(), r'^next_attempt_at=\d+$')
        due = int(first.stdout.strip().split('=')[1])
        self.assertTrue(55 <= due - time.time() <= 61)
        deferred = self.send('k1', rc=1)
        self.assertEqual((deferred.returncode, deferred.stdout.strip(), self.gateway_calls()), (75, first.stdout.strip(), 1))
        # Eleven older real-format failures + one more attempt = cap: terminal, recorded once.
        old = time.time() - 7200
        self.ledger.write_text(''.join(f'{iso(old + i)} state=failed reason=gateway_call rc=1 elapsed_s=4 key=k2\n' for i in range(11)))
        last = self.send('k2', rc=1)
        self.assertEqual((last.returncode, last.stdout.strip(), self.gateway_calls()), (1, 'state=undeliverable', 2))
        for _ in range(2):
            after = self.send('k2', rc=0)
            self.assertEqual((after.returncode, after.stdout.strip(), self.gateway_calls()), (76, 'state=undeliverable', 2))
        self.assertEqual(self.ledger.read_text().count('state=undeliverable'), 1)
        self.assertNotIn('private body', self.ledger.read_text())
        self.assertNotIn('21600000000', self.ledger.read_text())

    def test_missing_policy_fails_open_to_one_attempt(self):
        (self.runtime / 'owner_notify_retry.py').unlink()
        result = self.send('k3')
        self.assertEqual((result.returncode, self.gateway_calls()), (0, 1))


class ManagerTests(Runtime):
    def setUp(self):
        super().setUp()
        self.sent = Path(self.tmp.name) / 'sent-keys'
        self.mails = Path(self.tmp.name) / 'mails'
        self.write('whatsapp-owner-send.sh', '#!/usr/bin/env bash\n'
                   f'printf "%s\\n" "$2" >>{self.sent}\n'
                   'cat "$HOME/stub-out" 2>/dev/null; exit "$(cat "$HOME/stub-rc" 2>/dev/null || echo 0)"\n')
        self.write('incident-email.sh', f'#!/usr/bin/env bash\nprintf x >>{self.mails}\nexit 1\n')
        self.write('learning-gate-close.sh', '#!/usr/bin/env bash\necho "{}"\n')

    def stub(self, rc, out=''):
        (self.home / 'stub-rc').write_text(str(rc))
        (self.home / 'stub-out').write_text(out)

    def notify(self, kind='info', msg='Samantha — test'):
        subprocess.run(['bash', str(self.runtime / 'incident-notify.sh'), kind, msg], env=self.env, check=True, timeout=10)
        return next(p for p in (self.home / '.openclaw/incidents/queue').iterdir() if not p.name.startswith('.'))

    def run_manager(self):
        subprocess.run(['bash', str(self.runtime / 'incident-manager.sh')], env={**self.env, 'CLAW_INCIDENT_MANAGER_ONCE': '1'},
                       check=True, timeout=30)

    def keys(self):
        return self.sent.read_text().split() if self.sent.exists() else []

    def mail_count(self):
        return len(self.mails.read_text()) if self.mails.exists() else 0

    def events(self):
        return (self.home / '.openclaw/incidents/events.log').read_text()

    def test_failure_uses_owner_schedule_and_deferral_costs_no_attempt(self):
        folder = self.notify()
        due = int(time.time()) + 60
        self.stub(1, f'next_attempt_at={due}\n')
        self.run_manager()
        self.assertEqual(((folder / 'tries').read_text(), (folder / 'next').read_text(), self.mail_count()), ('1', str(due), 0))
        self.run_manager()
        self.assertEqual(len(self.keys()), 1)  # manager respects the owner's next attempt
        (folder / 'next').write_text('0')
        self.stub(75, f'next_attempt_at={due + 60}\n')
        self.run_manager()
        self.assertEqual(((folder / 'tries').read_text(), (folder / 'next').read_text(), self.mail_count()), ('1', str(due + 60), 0))

    def test_terminal_state_recorded_once_and_no_more_sends(self):
        folder = self.notify()
        self.stub(76, 'state=undeliverable\n')
        self.run_manager()
        self.assertEqual((folder / 'status').read_text(), 'undeliverable')
        self.assertTrue((folder / 'undeliverable').exists())
        self.assertEqual(self.mail_count(), 1)  # one final fallback, then nothing
        for _ in range(3):
            self.run_manager()
        self.assertEqual((len(self.keys()), self.mail_count(), self.events().count('state=undeliverable')), (1, 1, 1))
        # An identical alert is not re-queued over a terminal one.
        self.notify()
        self.assertEqual(self.events().count('event=queued'), 1)

    def test_hard_cap_without_policy_output(self):
        folder = self.notify()
        self.stub(1, '')
        for _ in range(20):
            (folder / 'next').write_text('0')
            self.run_manager()
        self.assertEqual(((folder / 'status').read_text(), len(self.keys())), ('undeliverable', 12))
        self.assertEqual(self.mail_count(), 10)  # tries 3..12, never every 5 min forever

    def test_accepted_is_final(self):
        folder = self.notify()
        self.stub(0, 'mid\n')
        for _ in range(3):
            self.run_manager()
        self.assertEqual(((folder / 'status').read_text(), self.keys()), ('notified', ['incident-' + folder.name]))

    def test_reopened_cycle_gets_a_new_key_and_recovery_key(self):
        folder = self.notify('remote_desktop', 'RDC unavailable')
        self.stub(0, 'mid\n')
        self.run_manager()
        subprocess.run(['bash', str(self.runtime / 'incident-close.sh'), 'remote_desktop', 'RDC ok'], env=self.env, check=True, timeout=10)
        self.notify('remote_desktop', 'RDC unavailable')
        self.assertEqual((folder / 'cycle').read_text(), '1')
        self.run_manager()
        subprocess.run(['bash', str(self.runtime / 'incident-close.sh'), 'remote_desktop', 'RDC ok'], env=self.env, check=True, timeout=10)
        legacy = 'recovery-' + hashlib.sha256(f'remote_desktop:{folder.name}'.encode()).hexdigest()[:24]
        cycle1 = 'recovery-' + hashlib.sha256(f'remote_desktop:{folder.name}:c1'.encode()).hexdigest()[:24]
        self.assertEqual(self.keys(), ['incident-' + folder.name, legacy, f'incident-{folder.name}-c1', cycle1])


if __name__ == '__main__':
    unittest.main(verbosity=2)
