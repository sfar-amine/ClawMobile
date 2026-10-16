#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock
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

    def test_android_parents_without_read_permission_are_anchored_with_o_path(self):
        # S24: open('/', O_RDONLY), '/data' and '/data/data' raise PermissionError; search is allowed.
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'workspace'; root.mkdir(); (root/'sample.txt').write_text('OTP: 482913')
            parents={'/'}|set(root.absolute().parts[1:-1])
            real=os.open; denied=[]
            def android_open(path,flags,*args,**kwargs):
                if path in parents and not flags & getattr(os,'O_PATH',0):
                    denied.append(path); raise PermissionError(13,'Permission denied')
                return real(path,flags,*args,**kwargs)
            with mock.patch.object(scan.os,'open',android_open):
                result=scan.scan_roots([('workspace',root)])
            self.assertEqual(denied,[]); self.assertEqual(result['state'],'ok')
            self.assertEqual(len(result['findings']),1); self.assertGreater(result['stats']['entries'],0)
            # The pre-fix behaviour (read-opening parents) is what Android refuses: prove the simulation bites.
            with mock.patch.object(scan.os,'open',android_open), mock.patch.object(scan,'PARENT_FLAGS',os.O_RDONLY|os.O_DIRECTORY):
                self.assertEqual(scan.scan_roots([('workspace',root)])['state'],'partial')
            self.assertTrue(denied)

    def test_open_root_reads_only_the_final_component_and_never_follows_parent_links(self):
        with tempfile.TemporaryDirectory() as directory:
            calls=[]; real=os.open
            def spy(path,flags,*args,**kwargs):
                calls.append((path,flags)); return real(path,flags,*args,**kwargs)
            target=Path(directory)/'a'/'b'; target.mkdir(parents=True)
            fd=scan.open_root(target,_open=spy); os.close(fd)
            if hasattr(os,'O_PATH'):
                self.assertTrue(all(flags & os.O_PATH for _,flags in calls[:-1]))
                self.assertFalse(calls[-1][1] & os.O_PATH)
            self.assertTrue(all(flags & os.O_NOFOLLOW for _,flags in calls[1:]))
            (Path(directory)/'link').symlink_to(Path(directory)/'a',target_is_directory=True)
            with self.assertRaises(OSError): scan.open_root(Path(directory)/'link'/'b')

    def test_huge_single_line_is_bounded_by_the_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            # One 1 MiB line without newline: the unbounded e-mail pattern used to be quadratic here.
            (root/'bundle.js').write_text('a'*(1024*1024-1))
            started=time.monotonic(); result=scan.scan_roots([('workspace',root)],seconds=1)
            self.assertLess(time.monotonic()-started,3)
            # Deterministic clock: the deadline must interrupt inside the line, between slices.
            with tempfile.TemporaryDirectory() as other:
                long_line='x'*(scan.SEGMENT*10)+' OTP: 482913'
                (Path(other)/'one-line').write_text(long_line)
                ticks=iter(range(10**6))
                with mock.patch.object(scan.time,'monotonic',lambda:next(ticks)):
                    bounded=scan.scan_roots([('workspace',Path(other))],seconds=6)
                self.assertEqual(bounded['state'],'partial'); self.assertEqual(bounded['findings'],[])
                self.assertEqual(len(scan.scan_roots([('workspace',Path(other))])['findings']),1)

    def test_value_on_a_slice_boundary_is_reported_once_with_its_line(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for position in (scan.SEGMENT-10, scan.SEGMENT+5, 2*scan.SEGMENT-3):
                token='ghp_'+'c'*30
                body='first line\r\nsecond\n'+'y'*position+' '+token+' '+'z'*(3*scan.SEGMENT)
                (root/'data.txt').write_text(body)
                result=scan.scan_roots([('workspace',root)])
                self.assertEqual([(r['type'],r['line']) for r in result['findings']],[('token',3)],position)
                self.assertNotIn(token,json.dumps(result))

    def test_line_numbers_across_blocks_and_crlf(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); lines=['ordinary text '*7]*20000; lines[15000]='OTP: 482913'
            data='\r\n'.join(lines).encode()
            (root/'log.txt').write_bytes(data)
            result=scan.scan_roots([('workspace',root)],file_bytes=len(data))
            self.assertEqual(result['state'],'ok'); self.assertEqual(result['findings'][0]['line'],15001)

    def test_binaries_are_ignored_not_truncated(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); big=2*1024*1024
            (root/'screen.png').write_bytes(b'\x89PNG\r\n\x1a\n'+b'OTP: 482913\n'*(big//12))
            (root/'app.js.map').write_text('{"mappings":"'+'A'*big+'"}')
            (root/'blob').write_bytes(b'header\0'+b'x'*big)
            (root/'latin1.txt').write_bytes(b'caf\xe9 '+b'x'*big)
            (root/'notes.txt').write_text('OTP: 482913')
            result=scan.scan_roots([('workspace',root)])
            self.assertEqual(result['state'],'ok')
            self.assertEqual(result['stats']['binary'],4); self.assertEqual(result['stats']['skipped'],4)
            self.assertEqual([r['path'] for r in result['findings']],['workspace/notes.txt'])
            self.assertLess(result['stats']['bytes'],2*scan.BLOCK+64)

    def test_truncated_text_stays_partial_even_when_a_character_is_cut(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'big.txt').write_text('OTP: 482913\n'+'é'*100)
            result=scan.scan_roots([('workspace',root)],file_bytes=15)
            self.assertEqual(result['state'],'partial'); self.assertEqual(result['stats']['binary'],0)
            self.assertEqual(len(result['findings']),1)

if __name__=='__main__': unittest.main()
