#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
spec = importlib.util.spec_from_file_location('scan', Path(__file__).with_name('workspace-secret-scan.py'))
scan = importlib.util.module_from_spec(spec); spec.loader.exec_module(scan)

class ScanTests(unittest.TestCase):
    def test_classes_metadata_only_and_email_warning(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            samples = ['Bearer ' + 'a'*24, 'sk-' + 'b'*30, 'ghp_' + 'c'*30, 'github_pat_' + 'd'*30, 'AKIA'+'A'*16, 'eyJabcdefghijk.abcdefghijk.abcdefghijk', '-----BEGIN PRIVATE KEY-----', 'OTP: 482913', '4111 1111 1111 1111', 'owner@example.invalid']
            (root/'sample.txt').write_text('\n'.join(samples))
            result = scan.scan_roots([('workspace',root)])
            self.assertEqual({r['type'] for r in result['findings']}, {'token','jwt','private_key','otp','card'})
            self.assertEqual(len(result['warnings']),1)
            rendered=json.dumps(result)
            for value in samples: self.assertNotIn(value,rendered)
            self.assertEqual(set(result['findings'][0]),{'path','line','type','hash'})
    def test_no_follow_private_exclusions_and_readonly(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); outside=root/'outside'; outside.mkdir()
            secret='Bearer '+'z'*30; (outside/'data').write_text(secret)
            workspace=root/'workspace'; workspace.mkdir(); (workspace/'linked').symlink_to(outside,target_is_directory=True)
            for name in ['node_modules','context','payments']:
                (workspace/name).mkdir(); (workspace/name/'data').write_text(secret)
            (workspace/'.env').write_text(secret); (workspace/'auth.json').write_text(secret)
            before={str(p):p.stat().st_mtime_ns for p in root.rglob('*') if p.is_file()}
            self.assertEqual(scan.scan_roots([('workspace',workspace)])['findings'],[])
            self.assertEqual(before,{str(p):p.stat().st_mtime_ns for p in root.rglob('*') if p.is_file()})
            (root/'alias').symlink_to(workspace,target_is_directory=True)
            self.assertEqual(scan.scan_roots([('workspace',root/'alias')])['state'],'partial')
    def test_volume_and_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for n in range(1200): (root/str(n)).write_text('ordinary text\n')
            started=time.monotonic(); result=scan.scan_roots([('workspace',root)])
            self.assertEqual(result['stats']['files'],1200); self.assertLess(time.monotonic()-started,1.5)
            bounded=scan.scan_roots([('workspace',root)],max_files=50)
            self.assertEqual(bounded['stats']['files'],50); self.assertEqual(bounded['state'],'partial')
    def test_text_findings_and_total_bounds(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'large').write_text(('OTP: 482913\n')*1000)
            result=scan.scan_roots([('workspace',root)],file_bytes=100,max_findings=3)
            self.assertEqual(result['state'],'partial'); self.assertEqual(result['stats']['bytes'],100); self.assertEqual(len(result['findings']),3)
            self.assertEqual(scan.scan_roots([('workspace',root)],seconds=0)['stats']['files'],0)
    def test_final_admitted_file_is_scanned(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'last').write_text('OTP: 482913')
            result=scan.scan_roots([('workspace',root)],max_files=1,max_bytes=11)
            self.assertEqual(len(result['findings']),1)
            self.assertEqual(result['findings'][0]['line'],1)
    def test_card_validation(self):
        self.assertTrue(scan.luhn('4111 1111 1111 1111')); self.assertFalse(scan.luhn('4111 1111 1111 1112')); self.assertFalse(scan.luhn('0000000000000000'))
    def test_sensitive_filenames_never_escape_as_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); name='sk-'+'q'*30+'.txt'
            (root/name).write_text('OTP: 482913')
            result=scan.scan_roots([('workspace',root)])
            self.assertEqual(len(result['findings']),1)
            self.assertNotIn(name,json.dumps(result))
            self.assertIn('[redacted-name-',result['findings'][0]['path'])
    def test_bare_api_field_names_are_not_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'source.py').write_text('access_token refresh_token maxTokens')
            self.assertEqual(scan.scan_roots([('repository',root)])['findings'],[])

    def test_sensitive_root_label_is_masked(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'data').write_text('OTP: 482913')
            label='sk-'+'q'*30
            result=scan.scan_roots([(label,root)])
            self.assertEqual(len(result['findings']),1)
            self.assertNotIn(label,json.dumps(result))
            self.assertIn('[redacted-name-',result['findings'][0]['path'])

if __name__=='__main__': unittest.main()
