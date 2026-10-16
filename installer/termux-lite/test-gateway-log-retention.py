import importlib.util
import json
from pathlib import Path
import os
import tempfile
import unittest
import time

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('retention',HERE/'gateway-log-retention.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
FIX=HERE.parents[1]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/f7/gateway-owner-observation.json'
class Retention(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.home=Path(self.tmp.name);self.logs=self.home/'.openclaw/workspace/logs';self.logs.mkdir(parents=True);self.log=self.logs/module.NAME
 def tearDown(self):self.tmp.cleanup()
 def test_real_owner_and_open_append_inode(self):
  observation=json.loads(FIX.read_text());self.assertTrue(observation['active']['append']);self.assertTrue(observation['legacy']['subsequentlyDeletedByClaude'])
  self.log.write_bytes(b'x'*observation['legacy']['bytes']);fd=os.open(self.log,os.O_WRONLY|os.O_APPEND);inode=self.log.stat().st_ino
  start=time.monotonic();result=module.rotate_gateway_log(self.home)
  self.assertLess(time.monotonic()-start,2);self.assertTrue(result['rotated']);self.assertEqual(self.log.stat().st_ino,inode)
  os.write(fd,b'after-rotation\n');os.close(fd);self.assertEqual(self.log.read_bytes(),b'after-rotation\n');self.assertEqual((self.logs/(module.NAME+'.1')).stat().st_size,module.MAX_BYTES)
  self.assertFalse((self.home/'.openclaw/health/gateway.stderr.log').exists())
 def test_three_archives_and_inherited_permissions(self):
  for i in range(1,4):(self.logs/(module.NAME+'.'+str(i))).write_bytes(b'z'*200)
  for _ in range(10):
   self.log.write_bytes(b'x'*200);module.rotate_gateway_log(self.home,max_bytes=64)
   self.assertEqual(self.log.stat().st_size,0)
   for i in range(1,4):
    f=self.logs/(module.NAME+'.'+str(i));self.assertLessEqual(f.stat().st_size,64);self.assertEqual(f.stat().st_mode&0o777,0o600)
  self.assertEqual(len(list(self.logs.iterdir())),4)
 def test_inherited_archive_is_bounded_even_without_active_rotation(self):
  archive=self.logs/(module.NAME+'.1');archive.write_bytes(b'z'*200);archive.chmod(0o644);self.log.write_bytes(b'x')
  self.assertEqual(module.rotate_gateway_log(self.home,max_bytes=64)['state'],'within_limit');self.assertEqual(archive.stat().st_size,64);self.assertEqual(archive.stat().st_mode&0o777,0o600);self.assertEqual(self.log.read_bytes(),b'x')
  archive.write_bytes(b'z'*200);archive.chmod(0o644);self.log.unlink();self.assertEqual(module.rotate_gateway_log(self.home,max_bytes=64)['state'],'absent');self.assertEqual(archive.stat().st_size,64);self.assertEqual(archive.stat().st_mode&0o777,0o600)
 def test_short_archive_write_preserves_bounded_tail(self):
  from unittest.mock import patch
  archive=self.logs/(module.NAME+'.1');expected=bytes(range(64));archive.write_bytes(b'old'*100+expected);self.log.write_bytes(b'x');real_pwrite=os.pwrite
  with patch.object(module.os,'pwrite',side_effect=lambda fd,data,offset:real_pwrite(fd,data[:5],offset)):module.rotate_gateway_log(self.home,max_bytes=64)
  self.assertEqual(archive.read_bytes(),expected)
 def test_no_rotation_below_threshold_or_absent(self):
  self.assertEqual(module.rotate_gateway_log(self.home)['state'],'absent');self.log.write_bytes(b'untouched');inode=self.log.stat().st_ino
  self.assertEqual(module.rotate_gateway_log(self.home)['state'],'within_limit');self.assertEqual(self.log.read_bytes(),b'untouched');self.assertEqual(self.log.stat().st_ino,inode)
 def test_symlink_and_hardlink_refused_without_effect(self):
  outside=self.home/'outside';outside.write_bytes(b'private');self.log.symlink_to(outside)
  with self.assertRaises(OSError):module.rotate_gateway_log(self.home)
  self.assertEqual(outside.read_bytes(),b'private');self.log.unlink();os.link(outside,self.log)
  with self.assertRaises(ValueError):module.rotate_gateway_log(self.home)
  self.assertEqual(outside.read_bytes(),b'private')
 def test_parent_symlink_and_archive_symlink_refused(self):
  self.log.write_bytes(b'x'*200);outside=self.home/'outside';outside.write_bytes(b'private');(self.logs/(module.NAME+'.1')).symlink_to(outside)
  with self.assertRaises(OSError):module.rotate_gateway_log(self.home,max_bytes=64)
  self.assertEqual(self.log.stat().st_size,200);self.assertEqual(outside.read_bytes(),b'private')
  (self.logs/(module.NAME+'.1')).unlink();self.logs.rename(self.logs.with_name('original'));self.logs.symlink_to(self.logs.with_name('original'))
  with self.assertRaises(OSError):module.rotate_gateway_log(self.home)
 def test_parent_replacement_stays_on_opened_directory(self):
  from unittest.mock import patch
  self.log.write_bytes(b'x'*200);original=self.logs.with_name('original');real_open=os.open;replaced=False
  def replacing_open(name,*args,**kwargs):
   nonlocal replaced
   fd=real_open(name,*args,**kwargs)
   if name=='logs' and not replaced:
    replaced=True;self.logs.rename(original);self.logs.mkdir();(self.logs/module.NAME).write_bytes(b'new-directory')
   return fd
  with patch.object(module.os,'open',side_effect=replacing_open):result=module.rotate_gateway_log(self.home,max_bytes=64)
  self.assertTrue(result['rotated']);self.assertEqual((original/module.NAME).stat().st_size,0);self.assertEqual(self.log.read_bytes(),b'new-directory')
 def test_owner_cycle_and_no_legacy_purge(self):
  script=(HERE/'samantha-health-manager.sh').read_text();self.assertEqual(script.count('python3 "$ROOT/gateway-log-retention.py"'),1);self.assertIn('sleep 15',script)
  source=(HERE/'gateway-log-retention.py').read_text();self.assertNotIn('plugin-captures',source);self.assertNotIn('gateway.stderr.log',source)
 def test_interrupted_sweep_uses_one_bounded_temporary(self):
  pending=self.logs/'.companion-openclaw-gateway.log.rotation.tmp';pending.write_bytes(b'incomplete');self.log.write_bytes(b'x'*200)
  self.assertTrue(module.rotate_gateway_log(self.home,max_bytes=64)['rotated']);self.assertFalse(pending.exists());self.assertEqual(len(list(self.logs.iterdir())),2)
 def test_copied_tail_metadata_never_discloses_content(self):
  self.log.write_bytes(b'private@example.invalid secret'*20);result=module.rotate_gateway_log(self.home,max_bytes=64)
  self.assertNotIn('private',json.dumps(result));self.assertNotIn('@',json.dumps(result));self.assertLessEqual((self.logs/(module.NAME+'.1')).stat().st_size,64)
if __name__=='__main__':unittest.main()
