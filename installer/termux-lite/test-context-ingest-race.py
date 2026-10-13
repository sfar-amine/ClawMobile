#!/data/data/com.termux/files/usr/bin/python3
"""Force pending -> processed during ingest and prove idempotent revisioning."""
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
            if not event_processed.wait(10):raise AssertionError('fast ingest did not move the event')
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

    connection=sqlite3.connect(root/'memory.db')
    rows=connection.execute('SELECT id,revision FROM events ORDER BY revision').fetchall()
    head=int(connection.execute("SELECT value FROM memory_meta WHERE key='current_revision'").fetchone()[0])
    connection.close()
    assert rows==[(event_id,1)],rows
    assert head==1,head
    assert not event.exists()
    assert (root/'processed'/event.name).is_file()
    archive=list((root/'history').glob('*.jsonl'))
    assert len(archive)==1 and len(archive[0].read_text().splitlines())==1
    print('PASS context ingest pending/processed race is idempotent (1 revision, 1 archive row)')
finally:
    if 'original_open' in globals():pathlib.Path.open=original_open
    shutil.rmtree(tmp,ignore_errors=True)
