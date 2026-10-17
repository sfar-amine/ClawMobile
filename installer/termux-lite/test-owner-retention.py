"""S24 log sizes and large generated owner volumes; no runtime activation."""
import argparse
import datetime as dt
import importlib.util
import json
import re
from pathlib import Path
import tempfile
import unittest
import subprocess

HERE=Path(__file__).parent
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module
tier0=load('tier0_retention','tier0-control.py')
logs=load('bounded_log','bounded-log.py')


class OwnerRetentionTests(unittest.TestCase):
    def test_110_releases_keep_current_lkg_and_five_newest(self):
        with tempfile.TemporaryDirectory() as directory:
            tier0.RELEASES=Path(directory)/'releases';tier0.RELEASES.mkdir()
            tier0.CURRENT=tier0.RELEASES/'current';tier0.LKG=tier0.RELEASES/'last-known-good'
            for index in range(110):
                root=tier0.RELEASES/f'release-{index:03}';root.mkdir()
                (root/'manifest.json').write_text(json.dumps({'version':1,'release_id':root.name,'files':{},
                   'created_at':(dt.datetime(2026,1,1,tzinfo=dt.timezone.utc)+dt.timedelta(days=index)).isoformat()}))
            tier0.CURRENT.symlink_to(tier0.RELEASES/'release-000')
            tier0.LKG.symlink_to(tier0.RELEASES/'release-001')
            unknown=tier0.RELEASES/'unknown';unknown.mkdir();(unknown/'manifest.json').write_text('{')
            pending=tier0.RELEASES/'building.tmp';pending.mkdir()
            outside=Path(directory)/'outside';outside.mkdir();(outside/'proof').write_text('preserve')
            (tier0.RELEASES/'external').symlink_to(outside)
            plan=tier0.prune_plan()
            self.assertEqual(len(plan['retained']),7)
            self.assertEqual(len(plan['remove']),103)
            tier0.cmd_prune(argparse.Namespace(keep=5,apply=True))
            self.assertTrue(tier0.CURRENT.exists());self.assertTrue(tier0.LKG.exists())
            self.assertTrue(unknown.exists());self.assertTrue(pending.exists());self.assertTrue((outside/'proof').exists())
            self.assertEqual(tier0.prune_plan()['remove'],[])

    def test_unknown_or_external_references_refuse_without_removal(self):
        with tempfile.TemporaryDirectory() as directory:
            tier0.RELEASES=Path(directory)/'releases';tier0.RELEASES.mkdir()
            tier0.CURRENT=tier0.RELEASES/'current';tier0.LKG=tier0.RELEASES/'last-known-good'
            with self.assertRaises(ValueError):tier0.prune_plan()
            outside=Path(directory)/'outside';outside.mkdir()
            tier0.CURRENT.symlink_to(outside);tier0.LKG.symlink_to(outside)
            with self.assertRaises(ValueError):tier0.prune_plan()
            self.assertTrue(outside.exists())

    def test_logs_bounded_with_large_preexisting_log_and_many_records(self):
        with tempfile.TemporaryDirectory() as directory:
            log=Path(directory)/'owner.log';log.write_bytes(b'a'*3_000_000)
            for index in range(600):logs.append_line(log,'record-'+str(index)+' '+('x'*1000),4096,3)
            self.assertTrue(log.read_text().endswith('x'*1000+'\n'))
            files=list(Path(directory).iterdir())
            self.assertEqual(len(files),4)
            for file in files:
                self.assertLessEqual(file.stat().st_size,5096)
                self.assertEqual(file.stat().st_mode & 0o777,0o600)

    def test_captured_s24_oversized_log_and_inherited_archive_permissions(self):
        fixture = json.loads((HERE.parent.parent / 'openclaw-plugin-mobile-ui' /
            'fixtures/s24-2026-10-10/p0-4-5/resources-inventory.json').read_text())
        gateway_size = next(size for name, size in fixture['inventory']['logs_top']
                            if name.endswith('/gateway.stderr.log'))
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'gateway.stderr.log'
            # The runtime text was not captured. Exercise its measured 36.6MB
            # extent with a neutral sparse file and a recognizable final tail.
            with log.open('wb') as output:
                output.truncate(gateway_size - 4)
                output.seek(0, 2)
                output.write(b'tail')
            log.chmod(0o644)
            archive = log.with_name(log.name + '.1')
            archive.write_bytes(b'prior'); archive.chmod(0o644)
            logs.append_line(log, 'next')
            self.assertEqual(log.read_bytes(), b'next\n')
            rotated = log.with_name(log.name + '.1')
            self.assertEqual(rotated.stat().st_size, 1024 * 1024)
            self.assertTrue(rotated.read_bytes().endswith(b'tail'))
            for item in Path(directory).iterdir():
                self.assertEqual(item.stat().st_mode & 0o777, 0o600)
            self.assertEqual(log.with_name(log.name + '.2').read_bytes(), b'prior')

    def test_symlink_hardlink_and_oversized_record_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'proof';target.write_text('preserve')
            log=Path(directory)/'owner.log';log.symlink_to(target)
            with self.assertRaises(ValueError):logs.append_line(log,'text')
            log.unlink();log.hardlink_to(target)
            with self.assertRaises(ValueError):logs.append_line(log,'text')
            self.assertEqual(target.read_text(),'preserve')
            with self.assertRaises(ValueError):logs.append_line(Path(directory)/'empty.log','x'*5000,4096)

    def test_stream_preserves_records_and_no_newline_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            log=Path(directory)/'stream.log'
            data=b'{"event":"one"}\n{"event":"two"}\nlast-no-newline'
            result=subprocess.run(['python3',str(HERE/'bounded-log.py'),str(log),'--stream'],input=data,capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(log.read_bytes(),data)

    def test_stream_timestamp_prefixes_each_line_once(self):
        # F3 (doc 62): stamped at line start only; a record split by the bounded read is not stamped twice.
        with tempfile.TemporaryDirectory() as directory:
            log=Path(directory)/'stream.log'
            data=b'one\n'+b'x'*70000+b'\nthree'
            result=subprocess.run(['python3',str(HERE/'bounded-log.py'),str(log),'--stream','--timestamp'],input=data,capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr)
            lines=log.read_bytes().split(b'\n')
            stamp=re.compile(rb'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d ')
            self.assertEqual(len(lines),3)
            self.assertTrue(all(stamp.match(line) for line in lines))
            self.assertTrue(lines[0].endswith(b' one'));self.assertTrue(lines[2].endswith(b' three'))
            self.assertEqual(lines[1].count(b'x'),70000)

    def test_600_deployment_logs_bound_without_removing_receipts_or_uncertain_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for index in range(600):
                prefix=root/f'companion-{index:04}'
                prefix.with_suffix('.json').write_text(json.dumps({'version':1,'state':'deployed','target':'a'*40}))
                prefix.with_suffix('.log').write_text('diagnostic')
            for state in ('failed','rollback_failed','running','unknown'):
                (root/f'companion-{state}.json').write_text(json.dumps({'version':1,'state':state,'target':'a'*40}))
                (root/f'companion-{state}.log').write_text('preserve-proof')
            self.assertEqual(logs.prune_deployment_logs(root),500)
            self.assertEqual(len(list(root.glob('*.json'))),604)
            self.assertEqual(len(list(root.glob('*.log'))),104)
            for state in ('failed','rollback_failed','running','unknown'):
                self.assertEqual((root/f'companion-{state}.log').read_text(),'preserve-proof')
            self.assertEqual(logs.prune_deployment_logs(root),0)


if __name__=='__main__':unittest.main()
