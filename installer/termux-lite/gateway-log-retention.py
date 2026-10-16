#!/usr/bin/env python3
"""Bound the Companion-owned Gateway append log in the existing health cycle.

Keep its inode: the detached Gateway retains an O_APPEND descriptor. Never
rename/unlink the active log, and never inspect/purge old health stderr logs.
"""
import fcntl
import json
import os
from pathlib import Path
import stat

MAX_BYTES=4*1024*1024
KEEP=3
NAME='companion-openclaw-gateway.log'
FLAGS=os.O_NOFOLLOW|os.O_NONBLOCK

def _regular(fd):
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:
        raise ValueError('unsafe_gateway_log')
    return info

def rotate_gateway_log(home, max_bytes=MAX_BYTES, keep=KEEP):
    if type(max_bytes) is not int or not 1<=max_bytes<=MAX_BYTES or type(keep) is not int or not 1<=keep<=KEEP:
        raise ValueError('invalid_gateway_log_limit')
    fds=[]
    try:
        # Open each canonical parent without following a symlink; all children
        # use dir_fd, so replacing pathnames cannot redirect the sweep.
        parent=os.open(home,os.O_RDONLY|os.O_DIRECTORY|FLAGS);fds.append(parent)
        for component in ('.openclaw','workspace','logs'):
            parent=os.open(component,os.O_RDONLY|os.O_DIRECTORY|FLAGS,dir_fd=parent);fds.append(parent)
        # Lock an existing directory inode too, including absent-active sweeps.
        try:fcntl.flock(parent,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return {'state':'busy','rotated':False}
        try:active=os.open(NAME,os.O_RDWR|FLAGS,dir_fd=parent)
        except FileNotFoundError:active=None
        if active is not None:
            fds.append(active);info=_regular(active)
            try:fcntl.flock(active,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:return {'state':'busy','rotated':False}
        archives=[]
        for index in range(1,keep+1):
            name=NAME+'.'+str(index)
            try:
                fd=os.open(name,os.O_RDONLY|FLAGS,dir_fd=parent)
                try:_regular(fd)
                finally:os.close(fd)
            except FileNotFoundError:continue
            archives.append(name)
        # All inherited archives are regular and closed; limit each before
        # rotation so an oversized old archive never escapes the bound.
        for name in archives:
            fd=os.open(name,os.O_RDWR|FLAGS,dir_fd=parent)
            try:
                old=_regular(fd);os.fchmod(fd,0o600)
                if old.st_size>max_bytes:
                    oldtail=os.pread(fd,max_bytes,old.st_size-max_bytes)
                    view=memoryview(oldtail);offset=0
                    while view:
                        written=os.pwrite(fd,view,offset)
                        if not written:raise OSError('gateway_archive_write_failed')
                        view=view[written:];offset+=written
                    os.ftruncate(fd,len(oldtail))
            finally:os.close(fd)
        if active is None:return {'state':'absent','rotated':False}
        if stat.S_IMODE(info.st_mode)!=0o600:os.fchmod(active,0o600)
        if info.st_size<max_bytes:return {'state':'within_limit','rotated':False}
        # Bounded tail only. The source inode is retained; Gateway can keep
        # appending. Copy/truncate has the conventional small lost-byte window.
        tail=os.pread(active,max_bytes,max(0,info.st_size-max_bytes))
        temp='.companion-openclaw-gateway.log.rotation.tmp'
        # One bounded temporary name under the existing active-inode lock.
        # A killed sweep is resumed without accumulating per-process files.
        out=os.open(temp,os.O_WRONLY|os.O_CREAT|FLAGS,0o600,dir_fd=parent)
        trusted_temp=False
        try:
            _regular(out);trusted_temp=True;os.fchmod(out,0o600);os.ftruncate(out,0)
            view=memoryview(tail)
            while view:
                n=os.write(out,view)
                if not n:raise OSError('gateway_archive_write_failed')
                view=view[n:]
            os.fsync(out)
        except BaseException:
            if trusted_temp:os.unlink(temp,dir_fd=parent)
            raise
        finally:os.close(out)
        try:
            try:os.unlink(NAME+'.'+str(keep),dir_fd=parent)
            except FileNotFoundError:pass
            for index in range(keep-1,0,-1):
                try:os.rename(NAME+'.'+str(index),NAME+'.'+str(index+1),src_dir_fd=parent,dst_dir_fd=parent)
                except FileNotFoundError:pass
            os.rename(temp,NAME+'.1',src_dir_fd=parent,dst_dir_fd=parent)
            os.ftruncate(active,0);os.fsync(active)
        finally:
            try:os.unlink(temp,dir_fd=parent)
            except FileNotFoundError:pass
        return {'state':'rotated','rotated':True,'archiveBytes':len(tail),'archivesKept':keep}
    finally:
        for fd in reversed(fds):os.close(fd)

def main():
    try:result=rotate_gateway_log(Path.home())
    except FileNotFoundError:result={'state':'absent','rotated':False}
    except (OSError,ValueError):result={'state':'refused','rotated':False,'reason':'gateway_log_retention_unavailable'}
    # Metadata only. Neither names/paths nor any log content enters diagnostics.
    print(json.dumps(result,separators=(',',':')))
    return 0 if result['state']!='refused' else 1
if __name__=='__main__':raise SystemExit(main())
