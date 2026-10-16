"""Fair J1 partitions on generated public files, without reading S24 content."""
import copy
import contextlib
import io
import importlib.util
import json
import sys
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

scan = load('partition_scan', 'workspace-secret-scan.py')
hook = load('partition_hook', 'nightly-secret-scan.py')

class PartitionTests(unittest.TestCase):
    def test_large_first_root_preserves_later_root_and_global_caps(self):
        with tempfile.TemporaryDirectory() as td:
            roots = []
            for index in range(8):
                folder = Path(td) / str(index)
                folder.mkdir()
                roots.append(('root_' + str(index), folder))
                for number in range(20 if index == 0 else 1):
                    (folder / str(number)).write_text('Bearer ' + 'publicFixture' * 3)
            result = scan.scan_roots(roots, max_files=16, max_entries=16, max_findings=16, max_bytes=4096)
            self.assertEqual(result['state'], 'partial')
            self.assertEqual(len(result['roots']), 8)
            self.assertEqual(result['roots'][0]['state'], 'partial')
            self.assertEqual({row['path'].split('/')[0] for row in result['findings']}, {label for label, _ in roots})
            for key, maximum in [('files', 16), ('entries', 16), ('bytes', 4096)]:
                self.assertLessEqual(result['stats'][key], maximum)
                self.assertEqual(sum(row['stats'][key] for row in result['roots']), result['stats'][key])
            self.assertLessEqual(sum(len(result[key]) for key in ('findings', 'warnings', 'accepted')), 16)
            projected = hook.closed_scan(result, scan)
            self.assertEqual(len(projected['roots']), 8)
            self.assertNotIn(td, json.dumps(projected))

    def test_unused_shares_flow_forward_and_empty_roots_are_complete(self):
        with tempfile.TemporaryDirectory() as td:
            empty = Path(td) / 'empty'
            empty.mkdir()
            later = Path(td) / 'later'
            later.mkdir()
            for index in range(7):
                (later / str(index)).write_text('ordinary')
            result = scan.scan_roots([('empty', empty), ('later', later)], max_files=8, max_entries=10)
            self.assertEqual(result['state'], 'ok')
            self.assertEqual([row['stats']['files'] for row in result['roots']], [0, 7])

    def test_expired_budget_describes_all_roots_without_reading_or_zero_claim(self):
        roots = [('root_' + str(index), Path('/never-read') / str(index)) for index in range(8)]
        with mock.patch.object(scan, 'open_root', side_effect=AssertionError('expired scan must not read')):
            result = scan.scan_roots(roots, seconds=0)
        self.assertEqual(result['state'], 'partial')
        self.assertEqual(len(result['roots']), 8)
        self.assertTrue(all(row['state'] == 'partial' for row in result['roots']))
        self.assertEqual(result['findings'], [])

    def test_inaccessible_root_is_partial_without_starving_later_root(self):
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / 'public').write_text('ordinary')
            result = scan.scan_roots([('missing', Path(td) / 'missing'), ('later', Path(td))])
            self.assertEqual([row['state'] for row in result['roots']], ['partial', 'ok'])
            self.assertEqual(result['stats']['files'], 1)

    def test_private_exclusions_and_sensitive_labels_remain_masked(self):
        with tempfile.TemporaryDirectory() as td:
            folder = Path(td)
            (folder / 'credentials').mkdir()
            (folder / 'credentials' / 'data').write_text('Bearer ' + 'privateMarker' * 3)
            (folder / 'auth.json').write_text('Bearer ' + 'privateMarker' * 3)
            label = 'sk-' + 'q' * 30
            result = scan.scan_roots([(label, folder)])
            self.assertEqual(result['findings'], [])
            self.assertEqual(result['stats']['files'], 0)
            self.assertNotIn(label, json.dumps(result))
            self.assertTrue(result['roots'][0]['label'].startswith('[redacted-name-'))

    def test_explicit_private_directory_root_is_never_read(self):
        with tempfile.TemporaryDirectory() as td:
            for name in ['credentials', 'context', 'payments', 'secret-archive']:
                folder = Path(td) / name
                folder.mkdir()
                (folder / 'data').write_text('Bearer ' + 'privateMarker' * 3)
                with mock.patch.object(scan, 'open_root', side_effect=AssertionError('private root must not be opened')):
                    out = scan.scan_roots([('runtime', folder)])
                self.assertEqual(out['state'], 'partial')
                self.assertEqual(out['stats']['files'], 0)
                self.assertEqual(out['findings'], [])

    def test_root_projection_rejects_malformed_metadata_and_accepts_legacy(self):
        with tempfile.TemporaryDirectory() as td:
            result = scan.scan_roots([('public', Path(td))])
        self.assertEqual(hook.closed_scan(result, scan)['roots'][0]['state'], 'ok')
        legacy = copy.deepcopy(result)
        del legacy['roots']
        self.assertNotIn('roots', hook.closed_scan(legacy, scan))
        mutations = []
        for field, value in [('durationMs', True), ('budgetMs', 10001), ('label', '/private'), ('state', 'complete'), ('value', 'never-echo')]:
            row = copy.deepcopy(result)
            row['roots'][0][field] = value
            mutations.append(row)
        row = copy.deepcopy(result)
        row['roots'][0]['stats']['files'] = 1
        mutations.append(row)
        row = copy.deepcopy(result)
        row['roots'][0]['state'] = 'partial'
        mutations.append(row)
        row = copy.deepcopy(result)
        row['roots'] *= 9
        mutations.append(row)
        for row in mutations:
            with self.assertRaises(ValueError):
                hook.closed_scan(row, scan)

    def test_nightly_timeout_continues_with_each_root_ten_seconds_and_shared_caps(self):
        calls = []
        roots = [('root_' + str(index), '/synthetic/not-read/' + str(index)) for index in range(8)]
        def runner(command, timeout):
            calls.append((command, timeout))
            if len(calls) == 1:
                raise TimeoutError('never-copy-private-error')
            label = command[3].split('=')[0]
            return 1, {'schemaVersion': 1, 'state': 'ok',
                'findings': [{'path': label + '/public', 'line': 1, 'type': 'token', 'hash': 'a' * 16}],
                'warnings': [], 'accepted': [],
                'stats': {'files': 1, 'bytes': 20, 'entries': 1, 'skipped': 0}}
        out, attention = hook.execute_scan(ROOT, roots, [], runner)
        self.assertTrue(attention)
        self.assertEqual(len(calls), 8)
        self.assertEqual(out['state'], 'partial')
        self.assertEqual(out['roots'][0]['state'], 'partial')
        self.assertIsNone(out['roots'][0]['stats'])
        self.assertTrue(all(row['state'] == 'ok' for row in out['roots'][1:]))
        self.assertEqual(len(out['findings']), 7)
        self.assertEqual(hook.SCAN_JOB_TIMEOUT, 128)
        for command, timeout in calls:
            self.assertEqual(timeout, 12)
            self.assertEqual(command[command.index('--seconds') + 1], '10')
        # Timed-out first root reserves its complete share, even with no counters.
        self.assertEqual(calls[0][0][calls[0][0].index('--max-files') + 1], '1250')
        self.assertEqual(calls[1][0][calls[1][0].index('--max-files') + 1], '1250')
        self.assertNotIn('never-copy-private-error', json.dumps(out))
        hook.closed_scan(out, scan)

    def test_nightly_unknown_timeout_counters_cannot_multiply_global_caps(self):
        calls = []
        def runner(command, timeout):
            calls.append(command)
            raise TimeoutError('private-error')
        out, attention = hook.execute_scan(ROOT, [('root_' + str(index), '/synthetic/not-read') for index in range(8)], [], runner)
        self.assertTrue(attention)
        self.assertEqual(len(calls), 8)
        for key, cap in [('files', 10000), ('bytes', 64*1024*1024), ('entries', 20000), ('findings', 1000)]:
            self.assertEqual(sum(int(command[command.index('--max-' + key) + 1]) for command in calls), cap)
        self.assertTrue(all(row['state'] == 'partial' for row in out['roots']))
        self.assertEqual(out['newFindingCount'], 0)

    def test_nightly_deadline_describes_unvisited_roots_without_calls(self):
        calls = []
        with mock.patch.object(hook.time, 'monotonic', side_effect=[0] + [129] * 16):
            out, attention = hook.execute_scan(ROOT, [('root_' + str(index), '/synthetic/not-read') for index in range(8)], [], lambda *args: calls.append(args))
        self.assertEqual(calls, [])
        self.assertTrue(attention)
        self.assertEqual(len(out['roots']), 8)
        self.assertTrue(all(row['state'] == 'partial' and row['budgetMs'] == 0 for row in out['roots']))

    def test_cli_cannot_raise_internal_or_volume_budgets(self):
        for flags in [['--seconds', '11'], ['--seconds', 'nan'], ['--max-files', '10001'], ['--max-bytes', str(64*1024*1024+1)], ['--max-entries', '20001'], ['--max-findings', '1001'], ['--max-files', '-1']]:
            with mock.patch.object(sys, 'argv', ['scan', '--root', 'public=/never-read'] + flags), mock.patch.object(scan, 'scan_roots', side_effect=AssertionError('invalid budget must not read')), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    scan.main()
                self.assertEqual(error.exception.code, 2)

    def test_duplicate_or_excess_roots_rejected_before_scan(self):
        for roots in [[('same', Path('/never-read'))] * 2, [('root_' + str(index), Path('/never-read')) for index in range(9)]]:
            with self.assertRaises(ValueError):
                scan.scan_roots(roots)

if __name__ == '__main__':
    unittest.main()
