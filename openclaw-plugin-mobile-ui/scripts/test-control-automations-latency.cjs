const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {execFileSync,execFile}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const {readControl,handleControl}=require('../dist/companion/control');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const fixture=path.join(__dirname,'../fixtures/s24-2026-10-10/r5-bis');
 const measures=JSON.parse(await fs.readFile(path.join(fixture,'measures.json'),'utf8'));
 const collectorMs=measures.controlAutomationsContract2.measures.find(row=>row.when.includes('P0-3')).ms;
 const probeMs=measures.digest.pythonStartupMs+measures.digest.realDb.msFirst;
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'automation-latency-'));
 const saved={state:process.env.OPENCLAW_STATE_DIR,playbooks:process.env.SAMANTHA_CONTROL_PLAYBOOKS,probe:process.env.R5_PROBE_MS,collector:process.env.R5_COLLECTOR_MS};
 let server;
 try{
  await fs.mkdir(path.join(root,'state'));await fs.mkdir(path.join(root,'reporting'));
  const source=path.join(root,'state/openclaw.sqlite');
  const sql=(query,params=[])=>execFileSync('python3',['-c','import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]);c.execute(sys.argv[2],json.loads(sys.argv[3]));c.commit();c.close()',source,query,JSON.stringify(params)]);
  await fs.copyFile(path.join(fixture,'cron-state.sqlite'),source);
  const firstId=execFileSync('python3',['-c',"import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('SELECT job_id FROM cron_jobs ORDER BY sort_order,job_id LIMIT 1').fetchone()[0])",source],{encoding:'utf8'}).trim();
  await fs.writeFile(path.join(root,'reporting/__init__.py'),'');
  // Stub only the collector boundary: real captured SQLite rows and measured owner latency.
  await fs.writeFile(path.join(root,'reporting/control_snapshot.py'),String.raw`import json,time,os,hashlib,sqlite3,sys
from pathlib import Path
r=Path(os.environ['OPENCLAW_STATE_DIR']);source=r/'state/openclaw.sqlite'
try:
 if source.is_symlink():raise ValueError()
 c=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,timeout=.02)
 rows=c.execute('SELECT job_id,enabled,job_json,schedule_identity FROM cron_jobs ORDER BY sort_order,job_id').fetchall();c.close()
 digest=hashlib.sha256()
 for row in rows:
  encoded=json.dumps(row,ensure_ascii=False,separators=(',',':')).encode();digest.update(len(encoded).to_bytes(8,'big'));digest.update(encoded)
 revision=digest.hexdigest()
except Exception:rows=[['gateway',1,'{}','daily']];revision=None
if '--automation-revision' in sys.argv:
 time.sleep(float(os.environ['R5_PROBE_MS'])/1000)
 print(json.dumps({'schemaVersion':1,'sourceRevision':revision}));sys.exit(0)
with (r/'calls').open('a') as f:f.write('call\n')
time.sleep(float(os.environ['R5_COLLECTOR_MS'])/1000)
items=[{'id':row[0]} for row in rows]
datarev=hashlib.sha256(json.dumps(items).encode()).hexdigest()
print(json.dumps({'schemaVersion':2,'sections':{'automations':{'schemaVersion':2,'resourceKey':'control/v2/automations','dataRevision':datarev,'availability':'ready','freshness':'fresh','remainingFreshMs':15000,'data':{'items':items,'available':True}}}}))
`);
  process.env.R5_PROBE_MS=String(probeMs);process.env.R5_COLLECTOR_MS=String(collectorMs);
  process.env.OPENCLAW_STATE_DIR=root;process.env.SAMANTHA_CONTROL_PLAYBOOKS=root;
  const began=performance.now();await readControl('automations');const baseline=performance.now()-began;
  assert.ok(baseline>=collectorMs);
  // Reference machine: this very CI host, same captured SQLite probe and Python
  // startup, followed by the route's 80 ms deferred timer. Calibrate before HTTP
  // assertions; do not mistake a shared-host scheduling pause for extra work.
  const referenceSamples=[];
  for(let i=0;i<3;i++){
   const start=performance.now();
   await new Promise((resolve,reject)=>execFile('python3',['-m','reporting.control_snapshot','--automation-revision'],{cwd:root,env:{...process.env}},error=>error?reject(error):resolve()));
   await delay(80);referenceSamples.push(performance.now()-start);
  }
  const referenceMs=Math.max(...referenceSamples);
  // Preserve the original 300 ms target on the recorded S24 reference.
  const routeBudgetMs=referenceMs*300/(probeMs+80);
  // A slow calibration must not silently admit blocking on the collector.
  assert.ok(routeBudgetMs<baseline/2,`reference ${referenceMs} cannot distinguish collector ${baseline}`);
  const withinBudget=(value,label)=>assert.ok(value.ms<routeBudgetMs,`${label} ${value.ms}; relative budget ${routeBudgetMs}; reference ${referenceMs}`);

  server=http.createServer(async(req,res)=>{if(!await handleControl(req,res,req.url)){res.writeHead(404);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  const get=async(query='')=>{
   const start=performance.now();
   const value=await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port,path:'/control/automations?contract=2'+query},response=>{
    let body='';response.on('data',x=>body+=x);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(body)}));
   }).on('error',reject));
   return {...value,ms:performance.now()-start};
  };
  const cold=await get();withinBudget(cold,'cold');assert.equal(cold.body.sections.automations.availability,'unavailable');assert.equal(cold.body.sections.automations.remainingFreshMs,0);assert.equal(cold.body.computation.deliveryMode,'deferred');
  await get();await delay(collectorMs);
  const warm=await get();withinBudget(warm,'warm');assert.equal(warm.body.computation.deliveryMode,'cache');assert.equal(warm.body.sections.automations.data.items[0].id,firstId);assert.ok(warm.body.sections.automations.remainingFreshMs>0&&warm.body.sections.automations.remainingFreshMs<=15000);
  await delay(30);const older=await get();assert.ok(older.body.sections.automations.remainingFreshMs<warm.body.sections.automations.remainingFreshMs);
  assert.equal((await fs.readFile(path.join(root,'calls'),'utf8')).trim().split('\n').length,2);
  const actualDigest=execFileSync('python3',['-m','reporting.control_snapshot','--automation-revision'],{cwd:root,encoding:'utf8'});
  assert.equal(JSON.parse(actualDigest).sourceRevision,measures.digest.fixtureDb.sha256);
  const rev=warm.body.sections.automations.dataRevision;
  sql('UPDATE cron_jobs SET state_json=?,runtime_updated_at_ms=?',['{"lastRun":123}',123]);
  const clock=await get();assert.equal(clock.body.computation.deliveryMode,'cache');assert.equal(clock.body.sections.automations.dataRevision,rev);withinBudget(clock,'runtime clock update');
  const healthyParallel=await Promise.all(Array.from({length:8},()=>get()));healthyParallel.forEach(x=>withinBudget(x,'parallel cache read'));
  assert.equal((await get('&knownRevision='+rev)).body.sections.automations.notModified,true);
  sql('UPDATE cron_jobs SET job_id=? WHERE job_id=?',['two',firstId]);
  const changed=await get('&knownRevision='+rev);withinBudget(changed,'configuration invalidation');assert.equal(changed.body.computation.deliveryMode,'deferred');assert.ok(!changed.body.sections.automations.data);assert.ok(!changed.body.sections.automations.notModified);
  await delay(collectorMs+200);assert.equal((await get()).body.sections.automations.data.items[0].id,'two');
  const forced=await get('&force=1');assert.equal(forced.body.computation.deliveryMode,'deferred');
  sql('UPDATE cron_jobs SET job_id=? WHERE job_id=?',['three','two']);
  await delay(collectorMs+200);
  const inFlightChanged=await get();assert.equal(inFlightChanged.body.computation.deliveryMode,'deferred');assert.ok(!inFlightChanged.body.sections.automations.data);
  await delay(collectorMs+200);assert.equal((await get()).body.sections.automations.data.items[0].id,'three');
  await fs.unlink(source);await fs.symlink(path.join(root,'calls'),source);
  // S24 reality (OpenClaw 2026.9.6 keeps cron jobs in SQLite): no readable revision source means a normal read, never "deferred" forever.
  const unavailable=await get();assert.notEqual(unavailable.body.computation?.deliveryMode,'deferred');assert.equal(unavailable.body.sections.automations.data.items[0].id,'gateway');
  await fs.unlink(source);
  const missing=await get();assert.notEqual(missing.body.computation?.deliveryMode,'deferred');assert.equal(missing.body.sections.automations.data.items[0].id,'gateway');
  assert.ok(!JSON.stringify(warm.body).includes('synthetic-private-fixture'));
  console.log(JSON.stringify({test:'control-automations-latency',baselineMs:+baseline.toFixed(2),coldMs:+cold.ms.toFixed(2),cachedMs:+warm.ms.toFixed(2),referenceMs:+referenceMs.toFixed(2),relativeBudgetMs:+routeBudgetMs.toFixed(2),referenceSamplesMs:referenceSamples.map(x=>+x.toFixed(2)),source:'S24 PR82 real STRICT SQLite capture; recorded 2475ms collector and 128ms cold probe replayed',passed:true}));
 }finally{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  for(const [key,value] of [['R5_PROBE_MS',saved.probe],['R5_COLLECTOR_MS',saved.collector],['OPENCLAW_STATE_DIR',saved.state],['SAMANTHA_CONTROL_PLAYBOOKS',saved.playbooks]])if(value===undefined)delete process.env[key];else process.env[key]=value;
  await fs.rm(root,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
