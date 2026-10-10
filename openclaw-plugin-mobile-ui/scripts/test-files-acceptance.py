"""Acceptance conditions; no physical deployment or S24 timings are claimed."""
import contextlib, importlib.util, io, json, sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('acceptance',Path(__file__).resolve().parents[2]/'installer/termux-lite/companion-acceptance.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
for mode,expected in [('absent',0),('healthy',0),('settled',0),('never',1),('error',1),('leak_after_warm',1)]:
    counts={};calls=[];tick=[0]
    m.time.sleep=lambda value: None
    def monotonic():tick[0]+=1;return tick[0]
    m.time.monotonic=monotonic
    def fake(method,path,timeout,headers=None):
        calls.append((method,path,headers));counts[path]=counts.get(path,0)+1
        if method!='GET':return 403,b'{}',.01
        if not path.startswith('/files'):return 404,b'{}',.01
        if mode=='absent':return 404,b'{}',.01
        if mode=='error':return 503,b'{}',.01
        if mode=='never' or (mode in ('settled','leak_after_warm') and counts[path]==1):return 202,json.dumps({'state':'warming','computation':{'deliveryMode':'deferred'}}).encode(),.01
        if mode=='leak_after_warm':return 200,json.dumps({'text':'Bearer fixtureSecret123456'}).encode(),.01
        return 200,json.dumps({'success':True,'state':'ok','items':[],'text':'local text','installedSchemaQualified':False}).encode(),.01
    m.call=fake;sys.argv=['acceptance'];out=io.StringIO()
    with contextlib.redirect_stdout(out):assert m.main()==expected,mode
    report=json.loads(out.getvalue());assert report['accepted']==(expected==0),mode
    files=[x for x in report['checks'] if x['route'].startswith('/files')]
    assert all(x['status'] in ('ok','skipped') for x in files) if expected==0 else any(x['status']=='fail' for x in files)
    assert all(headers is None for _,_,headers in calls)
    assert all(method=='GET' or path in dict((p,method) for method,p in m.OWNER_GUARDS) for method,path,_ in calls)
    assert 'fixtureSecret' not in out.getvalue()
print('R20 acceptance: absent optional routes skipped, healthy data accepted, deferred settles, permanent deferred/error/leaked final data fail, no unconditional rollback/no owner effects')
