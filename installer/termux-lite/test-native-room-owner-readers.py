#!/usr/bin/env python3
"""C17 reader-only milestone; synthetic owner fixtures, no native/DATA grant."""
import importlib.util
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),HERE/(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
    return value

people=load('people-trusted')
pulse=load('pulse-room')


class OwnerReaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name)
        self.contact=self.root/'wa_21620000001.md'
        self.owner=people.Contacts(types.SimpleNamespace(CONTACTS=self.root))
        self.header={key:None for key in people.FIELDS}
        self.header.update(state='active',scope='standard',rooms=['conversation','pulse'])
        self.prefix=(people.MARKER+'\n'+people.canonical(self.header)+'\n'+people.END+'\n').encode()
        self.contact.write_bytes(self.prefix+b'PRIVATE NOTE MUST NOT BE READ')
        self.workspace=self.root/'workspace-pulse'
        self.workspace.mkdir()
        for name,body in [('AGENTS.md',pulse.AGENTS),('USER.md',pulse.USER)]:
            (self.workspace/name).write_text(body)
        self.workspace_patch=patch.object(pulse,'WORKSPACE',self.workspace)
        self.workspace_patch.start()

    def tearDown(self):
        self.workspace_patch.stop()
        self.tmp.cleanup()

    def test_header_stops_at_end_without_reading_note(self):
        # FileIO.readline is deliberately unbuffered; track the descriptor
        # offset at close, independently of Python's internal read primitive.
        real_fdopen=os.fdopen
        positions=[]
        class Watched:
            def __init__(self,fd,*args,**kwargs):self.file=real_fdopen(fd,*args,**kwargs)
            def __enter__(self):return self.file
            def __exit__(self,*args):
                positions.append(os.lseek(self.file.fileno(),0,os.SEEK_CUR))
                self.file.close()
        prefix=self.prefix[:-1]
        for suffix in [b'\nPRIVATE NOTE',b'PRIVATE NOTE WITHOUT NEWLINE',b'']:
            with self.subTest(suffix=suffix):
                positions.clear()
                self.contact.write_bytes(prefix+suffix)
                with patch.object(people.os,'fdopen',Watched):
                    value=self.owner.metadata('+21620000001')
                self.assertEqual(value,self.header)
                self.assertEqual(positions,[len(prefix)])

    def test_invalid_end_marker_refused(self):
        prefix=(people.MARKER+'\n'+people.canonical(self.header)+'\n').encode()
        for marker in [people.END[:-1].encode(),b'INVALID END MARKER\nPRIVATE NOTE']:
            with self.subTest(marker=marker):
                self.contact.write_bytes(prefix+marker)
                with self.assertRaises(people.Refused):
                    self.owner.metadata('+21620000001')

    def test_unmanaged_note_stops_after_first_line(self):
        self.contact.write_bytes(b'not an owner header\nPRIVATE NOTE')
        self.assertIsNone(self.owner.metadata('+21620000001'))

    def test_metadata_fifo_refused_before_read(self):
        self.contact.unlink();os.mkfifo(self.contact)
        with self.assertRaises(people.Refused):
            self.owner.metadata('+21620000001')

    def test_metadata_symlink_refused(self):
        self.contact.unlink();self.contact.symlink_to(self.workspace/'AGENTS.md')
        with self.assertRaises(people.Refused):
            self.owner.metadata('+21620000001')

    def test_metadata_oversize_header_refused(self):
        self.contact.write_bytes((people.MARKER+'\n').encode()+b'x'*(people.CONTACT_HEADER_BYTES+1))
        with self.assertRaises(people.Refused):
            self.owner.metadata('+21620000001')

    def test_exact_instruction_bodies_only_and_no_writes(self):
        opened=[];real_open=os.open
        def observed(path,flags,*args,**kwargs):
            opened.append(Path(path).name)
            self.assertFalse(flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT))
            return real_open(path,flags,*args,**kwargs)
        with patch.object(pulse.os,'open',observed),patch.object(pulse,'workspace',side_effect=AssertionError('writer')):
            self.assertEqual(pulse.read_native_instructions(self.workspace),
                             {'AGENTS.md':pulse.AGENTS,'USER.md':pulse.USER})
        self.assertEqual(opened,['AGENTS.md','USER.md'])

    def test_wrong_workspace_refused(self):
        with self.assertRaisesRegex(ValueError,'NATIVE_ROOM_SOURCE_UNVERIFIED'):
            pulse.read_native_instructions(self.root)

    def test_instruction_drift_oversize_fifo_and_symlink_refused(self):
        path=self.workspace/'AGENTS.md'
        for kind in ['drift','oversize','fifo','symlink']:
            with self.subTest(kind=kind):
                path.unlink()
                if kind=='fifo':os.mkfifo(path)
                elif kind=='symlink':path.symlink_to(self.workspace/'USER.md')
                else:path.write_bytes(b'x'*(96001 if kind=='oversize' else 1))
                with self.assertRaises((ValueError,OSError)):
                    pulse.read_native_instructions(self.workspace)

    def test_workspace_symlink_refused(self):
        alias=self.root/'alias';alias.symlink_to(self.workspace,target_is_directory=True)
        with patch.object(pulse,'WORKSPACE',alias):
            with self.assertRaisesRegex(ValueError,'NATIVE_ROOM_SOURCE_UNVERIFIED'):
                pulse.read_native_instructions(alias)


if __name__=='__main__':
    unittest.main()
