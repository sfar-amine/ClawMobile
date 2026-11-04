#!/usr/bin/env python3
"""Session open: the first main run must not re-import the whatsapp plugin for its tool registry.

S24 31/10-02/11 (OpenClaw 2026.10.9): the first run after a Gateway start or a config hot reload spent 6.9 to 29.7 s
loading @openclaw/whatsapp on the main thread before the session opened. The selection is replayed with the exact
public OpenClaw bodies (npm fixtures) and the latency with the captured S24 gateway lines (no invented timings).
"""
from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parents[1] / 'openclaw-plugin-mobile-ui'
COMPAT = PLUGIN / 'fixtures/openclaw-2026.10.9-compat'
CAPTURE = PLUGIN / 'fixtures/s24-2026-11-02-session-open-plugin-tools'
HARNESS = COMPAT / 'plugin-tool-selection-harness.cjs'
# npm openclaw@2026.10.9 (archive sha256 43c61a00...04ab); tools-DQdRObqo.mjs is byte-identical on the S24 (02/11).
MODULES = {
    'tools-DQdRObqo.mjs': 'de48b6fa22ada137138857e06c8d04130568dffd31cc967edbf63f67213b8e85',
    'string-coerce-1VuiLaaR.mjs': '0dea5cd027293a4f5cf9451d652563e91c44c62b534c4b0548b81cee61751229',
    'string-normalization-D6DKCpwE.mjs': '954d41914e82db33e618da847f711ff4dea8508d4c7b268c77641410bae42ea7',
    'regexp-BZyMFTlj.mjs': '35bc25bc6ec71a81fbd9548a563731c410228d746be3daff57b833ab833632c4',
    'glob-pattern-DuaaJ-nB.mjs': '0ca68c82264181daa89b352d9b940bbde4d8c4449f1075780d375aefb31a8e8c',
    'tool-policy-shared-CNWjndK7.mjs': 'ff73e84552ab12673b9048f70f6827289ed5a3d97927e93a34515017f5bed507',
    'tool-grant-allowlist-m1tXxJWt.mjs': '58f927279df4232f25dfbe5f00dccb698b9b56ca2e111f141b9c794b2fcef875',
    'manifest-tool-availability-DJlsKWK1.mjs': '23d541583c1f14bc40426e5522b7ab3bff7642e6edacf3ad94c4a4e3dda4f44f',
}
# npm @openclaw/whatsapp@2026.10.9 openclaw.plugin.json, same sha256 as the installed S24 copy (02/11).
WHATSAPP_MANIFEST_SHA256 = '1ffc4c4cadab49f683fb4981a57a7e4e1d709735916143e35ef7a5090611ff48'
GATEWAY_LOG_SHA256 = '5a1c9ef01e8913852ca327d0552e2091449cdd1294c635ce3b9d41f03a3f3889'
# agents.entries.main.tools on the S24 on 02/11 (after #126), the policy this change extends.
S24_MAIN_TOOLS = {'deny': ['skills_read', 'skills_search']}
# Budgets for the replayed cold runs once the whatsapp registry load is gone (S24 under deploy load).
RUN_START_TO_OPEN_BUDGET_S = 7.0
RECETTE_TO_OPEN_BUDGET_S = 20.0


def node_binary(override):
    if not override:
        return 'node'
    candidate = Path(override)
    return str(candidate / 'node') if candidate.is_dir() else str(candidate)


NODE = node_binary(os.environ.get('LOCALCI_NODE26_BIN'))


def load_config_owner():
    spec = importlib.util.spec_from_file_location('model_efficiency_config', HERE / 'model-efficiency-config.py')
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


cfg = load_config_owner()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stamp(value: str) -> float:
    return dt.datetime.fromisoformat(value.replace('+00:00', '')).replace(tzinfo=dt.timezone.utc).timestamp()


def cold_runs(lines):
    """Per run: start, whatsapp registry load (ms), session open, from the captured gateway lines."""
    runs, order, by_session = {}, [], {}
    pending_load = None
    for line in lines:
        at, _, body = line.partition(' ')
        t = stamp(at)
        if 'embedded run start:' in body:
            run = re.search(r'runId=(\S+)', body).group(1)
            session = re.search(r'sessionId=(\S+)', body).group(1)
            runs[run] = {'start': t, 'session': session, 'load_ms': 0.0}
            order.append(run)
            by_session[session] = run
        elif '[plugins] loading whatsapp' in body:
            # Only a load inside a run that has not opened yet belongs to that run (not a config hot reload).
            pending_load = order[-1] if order and 'open' not in runs[order[-1]] else None
        elif re.search(r'\[plugins\] loaded \d+ plugin\(s\) \(1 attempted\) in ', body) and pending_load:
            runs[pending_load]['load_ms'] = float(re.search(r' in ([0-9.]+)ms', body).group(1))
            runs[pending_load]['plugins'] = int(re.search(r'loaded (\d+) plugin', body).group(1))
            runs[pending_load]['load_end'] = t
            pending_load = None
        elif 'reason="run_started"' in body:
            run = by_session.get(re.search(r'sessionId=(\S+)', body).group(1))
            if run and 'open' not in runs[run]:
                runs[run]['open'] = t
                runs[run]['key'] = re.search(r'sessionKey=(\S+)', body).group(1)
        elif 'liveness heartbeat delayed' in body:
            runs.setdefault('_heartbeats', []).append(
                (t, int(re.search(r'elapsed=(\d+)ms', body).group(1))))
    return runs, order


class SessionOpenPluginTools(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dist = Path(cls.tmp.name) / 'dist'
        cls.dist.mkdir()
        for name, digest in MODULES.items():
            raw = gzip.decompress((COMPAT / (name + '.gz')).read_bytes())
            assert sha256(raw) == digest, name
            (cls.dist / name).write_bytes(raw)
        manifest_bytes = (CAPTURE / 'whatsapp-openclaw.plugin.json').read_bytes()
        assert sha256(manifest_bytes) == WHATSAPP_MANIFEST_SHA256
        cls.whatsapp = json.loads(manifest_bytes)
        cls.mobile_ui = json.loads((PLUGIN / 'openclaw.plugin.json').read_text())
        log_bytes = (CAPTURE / 'gateway-cold-runs.log').read_bytes()
        assert sha256(log_bytes) == GATEWAY_LOG_SHA256
        cls.lines = log_bytes.decode().splitlines()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def select(self, cases):
        payload = Path(self.tmp.name) / 'input.json'
        payload.write_text(json.dumps({'plugins': [self.whatsapp, self.mobile_ui], 'cases': cases}))
        out = subprocess.run([NODE, str(HARNESS), str(self.dist), str(payload)],
                             capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout)['selected']

    def patched_main_deny(self):
        config = {'agents': {'entries': {'main': {'tools': json.loads(json.dumps(S24_MAIN_TOOLS))}}}}
        patched, changes = cfg._patch_config(config)
        self.assertIn('agents.entries.main.tools.deny', changes)
        return patched['agents']['entries']['main']['tools']['deny']

    def test_denied_names_cover_the_whole_whatsapp_tool_contract(self):
        self.assertEqual(self.whatsapp['id'], 'whatsapp')
        self.assertIsNone(self.whatsapp.get('toolMetadata'))
        self.assertEqual(set(self.whatsapp['contracts']['tools']), set(cfg.MAIN_DENIED_CHANNEL_TOOLS))

    def test_s24_policy_loads_whatsapp_and_the_patched_policy_does_not(self):
        deny = self.patched_main_deny()
        self.assertEqual(deny, ['skills_read', 'skills_search', 'whatsapp_call', 'whatsapp_login', 'web_search'])
        selected = self.select({
            's24_now': {'deny': S24_MAIN_TOOLS['deny'], 'allow': None},
            'patched': {'deny': deny, 'allow': None},
            'call_only': {'deny': [*S24_MAIN_TOOLS['deny'], 'whatsapp_call'], 'allow': None},
        })
        self.assertEqual(selected['s24_now'], ['openclaw-plugin-mobile-ui', 'whatsapp'])
        self.assertEqual(selected['patched'], ['openclaw-plugin-mobile-ui'])
        # One name is not enough: whatsapp_login alone keeps the module in the registry.
        self.assertEqual(selected['call_only'], ['openclaw-plugin-mobile-ui', 'whatsapp'])

    def test_samantha_tools_stay_available_to_the_brain(self):
        deny = set(self.patched_main_deny())
        self.assertFalse(deny & set(self.mobile_ui['contracts']['tools']))
        self.assertIn('openclaw-plugin-mobile-ui', self.select({'patched': {'deny': sorted(deny), 'allow': None}})['patched'])

    def test_captured_cold_runs_spend_most_of_the_pre_session_window_in_the_whatsapp_load(self):
        runs, order = cold_runs(self.lines)
        cold = [runs[r] for r in order if runs[r]['load_ms']]
        self.assertEqual([r['load_ms'] for r in cold], [6867.0, 14822.5, 14239.7, 29703.7])
        for run in cold:
            with self.subTest(key=run['key']):
                window = run['open'] - run['start']
                self.assertEqual(run['plugins'], 6)
                self.assertGreater(run['load_ms'] / 1000, 0.5 * window)
                self.assertLessEqual(window - run['load_ms'] / 1000, RUN_START_TO_OPEN_BUDGET_S)
        # Same session, same afternoon, no registry load: the run opens in about 2 s.
        warm = runs[order[-1]]
        self.assertEqual(warm['load_ms'], 0.0)
        self.assertLess(warm['open'] - warm['start'], 3.0)

    def test_the_45_s_wait_is_the_post_reload_registry_load(self):
        runs, order = cold_runs(self.lines)
        run = next(runs[r] for r in order if runs[r].get('key', '').endswith('recette-deploy:20261102t162503z')
                   and runs[r]['load_ms'])
        started = stamp('2026-11-02T16:25:03.000')  # recette start, encoded in the session key
        self.assertAlmostEqual(run['open'] - started, 45.41, places=2)
        self.assertLessEqual(run['open'] - started - run['load_ms'] / 1000, RECETTE_TO_OPEN_BUDGET_S)
        # The load is synchronous: the Gateway liveness heartbeat stalls for the whole window.
        frozen = [elapsed for at, elapsed in runs['_heartbeats'] if run['load_end'] <= at <= run['open']]
        self.assertEqual(frozen, [46180])

    def test_config_owner_is_idempotent_on_the_s24_shape(self):
        config = {'agents': {'entries': {'main': {'tools': {'deny': self.patched_main_deny()}}}}}
        _, changes = cfg._patch_config(config)
        self.assertNotIn('agents.entries.main.tools.deny', changes)


if __name__ == '__main__':
    unittest.main()
