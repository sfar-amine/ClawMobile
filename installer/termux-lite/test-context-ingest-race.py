#!/data/data/com.termux/files/usr/bin/python3
"""Force concurrent ingests of one pending event and prove idempotent revisioning.

M6 (#262) removes the transient pending copy once SQLite and the fsynced history agree, instead of
moving it to processed/. The races of #238 are kept: a worker that opens the event after another one
committed and removed it, and two workers that validated the same file and release it together."""
import datetime
import importlib.util
import json
import os
import pathlib
import shutil
import sqlite3
import sys
import tempfile
import threading

HERE=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
tmp=pathlib.Path(tempfile.mkdtemp(prefix='samantha-context-race.'))
root=tmp/'context-sync'
os.environ['SAMANTHA_CONTEXT_ROOT']=str(root)
spec=importlib.util.spec_from_file_location('context_store_race',HERE/'context-store.py')
store=importlib.util.module_from_spec(spec);spec.loader.exec_module(store)

try:
    pending=root/'pending';pending.mkdir(parents=True)
    event_id='a'*64
    event=pending/(event_id+'.json')
    event.write_text(json.dumps({
        'version':2,
        'id':event_id,
        'surface':'chat',
        'kind':'learning',
        'text':'concurrent identical event',
        'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    },separators=(',',':')))

    with store.connect() as connection:store.migrate(connection)
    delayed_at_open=threading.Event()
    event_processed=threading.Event()
    original_open=pathlib.Path.open

    def ordered_open(path,*args,**kwargs):
        if threading.current_thread().name=='delayed-ingest' and path==event:
            delayed_at_open.set()
            if not event_processed.wait(10):raise AssertionError('fast ingest did not settle the event')
        return original_open(path,*args,**kwargs)

    pathlib.Path.open=ordered_open
    results=[]
    errors=[]
    def delayed():
        try:
            with store.connect() as connection:results.append(store.ingest_file(connection,event))
        except Exception as error:errors.append(error)
    thread=threading.Thread(target=delayed,name='delayed-ingest')
    thread.start()
    assert delayed_at_open.wait(10),'delayed ingest did not reach the forced race'
    with store.connect() as connection:results.append(store.ingest_file(connection,event))
    event_processed.set();thread.join(10)
    assert not thread.is_alive(),'delayed ingest did not finish'
    assert not errors,errors
    assert sorted(result['inserted'] for result in results)==[False,True],results
    assert {result['revision'] for result in results}=={1},results

    # A second interleaving lets both workers open and validate the same
    # pending file, then releases both removals of the transient copy together.
    # Exactly one removal wins; the loser must tolerate the already removed copy.
    pathlib.Path.open=original_open
    second_id='b'*64
    second=pending/(second_id+'.json')
    second.write_text(json.dumps({
        'version':2,
        'id':second_id,
        'surface':'work',
        'kind':'checkpoint',
        'text':'concurrent identical move',
        'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    },separators=(',',':')))
    release_barrier=threading.Barrier(2,timeout=10)
    original_unlink=pathlib.Path.unlink
    def ordered_unlink(path,*args,**kwargs):
        if path==second:
            release_barrier.wait()
        return original_unlink(path,*args,**kwargs)
    pathlib.Path.unlink=ordered_unlink
    move_results=[]
    move_errors=[]
    def simultaneous_move():
        try:
            with store.connect() as connection:move_results.append(store.ingest_file(connection,second))
        except Exception as error:move_errors.append(error)
    workers=[threading.Thread(target=simultaneous_move) for _ in range(2)]
    for worker in workers:worker.start()
    for worker in workers:worker.join(15)
    pathlib.Path.unlink=original_unlink
    assert not any(worker.is_alive() for worker in workers),'simultaneous move did not finish'
    assert not move_errors,move_errors
    assert sorted(result['inserted'] for result in move_results)==[False,True],move_results
    assert {result['revision'] for result in move_results}=={2},move_results

    connection=sqlite3.connect(root/'memory.db')
    rows=connection.execute('SELECT id,revision FROM events ORDER BY revision').fetchall()
    head=int(connection.execute("SELECT value FROM memory_meta WHERE key='current_revision'").fetchone()[0])
    connection.close()
    assert rows==[(event_id,1),(second_id,2)],rows
    assert head==2,head
    # M6 contract: no transient copy survives once both durable truths agree (no processed/ copy).
    assert not event.exists()
    assert not (root/'processed'/event.name).exists()
    assert not second.exists()
    assert not (root/'processed'/second.name).exists()
    archive=list((root/'history').glob('*.jsonl'))
    assert len(archive)==1 and len(archive[0].read_text().splitlines())==2
    print('PASS context ingest races are idempotent (2 events, contiguous revisions, 2 archive rows)')
finally:
    if 'original_open' in globals():pathlib.Path.open=original_open
    if 'original_unlink' in globals():pathlib.Path.unlink=original_unlink
    shutil.rmtree(tmp,ignore_errors=True)
