"""Rotate ordinary owner logs before opening a writer; never proof journals.

Callers already hold their existing owner lock. A long-lived writer must use
append_line for each record; renaming a log still held open cannot bound it.
"""
import argparse
import os
from pathlib import Path
import stat
import sys
import tempfile
import json
import re
import datetime


def rotate(path, max_bytes=1024*1024, keep=3):
    path=Path(path)
    if type(max_bytes) is not int or max_bytes < 1 or type(keep) is not int or not 1 <= keep <= 10:
        raise ValueError('invalid_log_retention')
    paths=[path]+[path.with_name(path.name+'.'+str(n)) for n in range(1,keep+1)]
    for item in paths:
        try:
            info=item.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('unsafe_log_file')
        os.chmod(item, 0o600, follow_symlinks=False)
    if not path.exists() or path.stat().st_size < max_bytes:
        return False
    paths[-1].unlink(missing_ok=True)
    for index in range(keep-1,0,-1):
        if paths[index].exists():
            os.replace(paths[index],paths[index+1])
    os.replace(path,paths[1])
    # An inherited oversized log should not become an oversized archive.
    if paths[1].stat().st_size > max_bytes:
        with paths[1].open('rb') as source:
            source.seek(-max_bytes,os.SEEK_END)
            tail=source.read(max_bytes)
        fd,tmp=tempfile.mkstemp(prefix='.'+path.name+'.',dir=path.parent)
        try:
            with os.fdopen(fd,'wb') as target:
                target.write(tail)
            os.replace(tmp,paths[1])
        finally:
            if os.path.exists(tmp):os.unlink(tmp)
    return True


CORRELATION_KEYS = frozenset(("turnId", "runId", "clientRunId"))
# Same maximum as runs.ts CLIENT_RUN_ID_RE; this stricter diagnostic projection excludes punctuation.
CORRELATION_VALUE = re.compile(r"[A-Za-z0-9_-]{1,160}\Z")


def correlation_prefix(values):
    """Caller-owned opaque IDs only; never arbitrary metadata or message text."""
    fields = {}
    for item in values:
        key, separator, value = item.partition("=")
        if not separator or key not in CORRELATION_KEYS or key in fields or not CORRELATION_VALUE.fullmatch(value):
            raise ValueError("invalid_log_correlation")
        if value.lower().startswith(("sk-", "ghp_", "github_pat_", "bearer")):
            raise ValueError("invalid_log_correlation")
        fields[key] = value
    return "".join(f"{key}={value} " for key, value in fields.items())


def append_line(path, text, max_bytes=1024*1024, keep=3):
    # Bound one record too; do not emit its text in diagnostics on refusal.
    encoded=(text+'\n').encode('utf-8')
    append_bytes(path,encoded,max_bytes,keep)


def append_bytes(path, encoded, max_bytes=1024*1024, keep=3):
    if len(encoded)>max_bytes:
        raise ValueError('log_record_too_large')
    rotate(path,max_bytes,keep)
    fd=os.open(path,os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:
            raise ValueError('unsafe_log_file')
        with os.fdopen(fd,'ab',closefd=False) as target:
            target.write(encoded)
    finally:
        os.close(fd)


def prune_deployment_logs(directory, keep=100):
    """Receipt remains the canonical proof; unknown/failed attempts stay intact."""
    if type(keep) is not int or not 1 <= keep <= 1000:
        raise ValueError('invalid_log_retention')
    root=Path(directory);candidates=[]
    for receipt in root.glob('companion-*.json'):
        try:
            info=receipt.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>2*1024*1024:
                continue
            row=json.loads(receipt.read_text())
            if row.get('version')!=1 or row.get('state') not in ('deployed','rolled_back','refused'):
                continue
            if not re.fullmatch('[0-9a-f]{7,40}',str(row.get('target',''))):
                continue
            candidates.append((info.st_mtime_ns,receipt))
        except (OSError,ValueError,TypeError):
            continue
    candidates.sort(key=lambda value:value[0],reverse=True)
    removed=0
    for _,receipt in candidates[keep:]:
        log=receipt.with_suffix('.log')
        for file in [log]+[log.with_name(log.name+'.'+str(index)) for index in range(1,4)]:
            try:
                info=file.lstat()
                if stat.S_ISREG(info.st_mode) and info.st_nlink==1:
                    file.unlink();removed+=1
            except FileNotFoundError:
                pass
    return removed


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('path');parser.add_argument('--max-bytes',type=int,default=1024*1024)
    parser.add_argument('--keep',type=int,default=3);parser.add_argument('--append')
    parser.add_argument('--stream',action='store_true')
    # F3 (doc 62): a stream line without a clock cannot be correlated with the app, the relay or the health owner.
    parser.add_argument('--timestamp',action='store_true',help='prefix each streamed line with the local ISO time')
    parser.add_argument('--correlation',action='append',default=[],metavar='KEY=ID',
                        help='opaque turnId, runId or clientRunId; repeat for multiple keys')
    parser.add_argument('--deployment-logs',action='store_true')
    args=parser.parse_args()
    try:
        correlation=correlation_prefix(args.correlation)
    except ValueError:
        parser.error('invalid_log_correlation')
    if correlation and not (args.stream or args.append is not None):
        parser.error('correlation_requires_writer')
    if args.max_bytes<1 or not 1<=args.keep<=10:
        parser.error('invalid_log_retention')
    if args.deployment_logs:
        if args.stream or args.append is not None:
            parser.error('deployment_log_mode_conflict')
        prune_deployment_logs(args.path)
    elif args.stream:
        if args.append is not None:
            parser.error('append_and_stream_conflict')
        # One sink per existing owner process, never a daemon or scheduler.
        # Bounded reads also handle a producer with no newline.
        at_line_start=True
        while True:
            data=sys.stdin.buffer.readline(min(65536,args.max_bytes))
            if not data:
                break
            ended_line=data.endswith(b'\n')
            if at_line_start:
                prefix=correlation
                if args.timestamp:
                    stamp=datetime.datetime.now().astimezone().isoformat(timespec='milliseconds')
                    prefix=stamp+' '+prefix
                if prefix:
                    # Keep the producer bytes, even when a prefix crosses a rotation boundary.
                    combined=prefix.encode('ascii')+data
                    for offset in range(0,len(combined),args.max_bytes):
                        append_bytes(args.path,combined[offset:offset+args.max_bytes],args.max_bytes,args.keep)
                else:
                    append_bytes(args.path,data,args.max_bytes,args.keep)
            else:
                append_bytes(args.path,data,args.max_bytes,args.keep)
            at_line_start=ended_line
    elif args.append is None:
        rotate(args.path,args.max_bytes,args.keep)
    else:
        append_line(args.path,correlation+args.append,args.max_bytes,args.keep)
