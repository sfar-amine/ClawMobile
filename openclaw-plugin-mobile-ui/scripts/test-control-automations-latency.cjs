const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {execFileSync}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const {readControl,handleControl}=require('../dist/companion/control');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'automation-latency-'));
 const saved={state:process.env.OPENCLAW_STATE_DIR,playbooks:process.env.SAMANTHA_CONTROL_PLAYBOOKS};
 let server;
 try{
  await fs.mkdir(path.join(root,'state'));await fs.mkdir(path.join(root,'reporting'));
  const source=path.join(root,'state/openclaw.sqlite');
  const sql=(query,params=[])=>execFileSync('python3',['-c','import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]);c.execute(sys.argv[2],json.loads(sys.argv[3]));c.commit();c.close()',source,query,JSON.stringify(params)]);
  sql('CREATE TABLE cron_jobs(job_id TEXT,enabled INTEGER,job_json TEXT,schedule_identity TEXT,sort_order INTEGER,state_json TEXT,runtime_updated_at_ms INTEGER)');
  sql('INSERT INTO cron_jobs VALUES(?,?,?,?,?,?,?)',['one',1,'{"instruction":"synthetic-private-fixture"}','daily',1,'{}',0]);
  await fs.writeFile(path.join(root,'reporting/__init__.py'),'');
  // Synthetic reporting owner over file29's attested columns; not a real S24 DB capture.
  await fs.writeFile(path.join(root,'reporting/control_snapshot.py'),String.raw`import json,time,os,hashlib,sqlite3,sys
from pathlib import Path
r=Path(os.environ['OPENCLAW_STATE_DIR']);source=r/'state/openclaw.sqlite'
try:
 if source.is_symlink():raise ValueError()
 c=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,timeout=.02)
 rows=c.execute('SELECT job_id,enabled,job_json,schedule_identity FROM cron_jobs ORDER BY sort_order,job_id').fetchall();c.close()
 revision=hashlib.sha256(json.dumps(rows).encode()).hexdigest()
except Exception:rows=[['gateway',1,'{}','daily']];revision=None
if '--automation-revision' in sys.argv:
 print(json.dumps({'schemaVersion':1,'sourceRevision':revision}));sys.exit(0)
with (r/'calls').open('a') as f:f.write('call\n')
time.sleep(2.4)
items=[{'id':row[0]} for row in rows]
datarev=hashlib.sha256(json.dumps(items).encode()).hexdigest()
print(json.dumps({'schemaVersion':2,'sections':{'automations':{'schemaVersion':2,'resourceKey':'control/v2/automations','dataRevision':datarev,'availability':'ready','freshness':'fresh','remainingFreshMs':15000,'data':{'items':items,'available':True}}}}))
`);
  process.env.OPENCLAW_STATE_DIR=root;process.env.SAMANTHA_CONTROL_PLAYBOOKS=root;
  const began=performance.now();await readControl('automations');const baseline=performance.now()-began;
  assert.ok(baseline>=2400);
  server=http.createServer(async(req,res)=>{if(!await handleControl(req,res,req.url)){res.writeHead(404);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  const get=async(query='')=>{
   const start=performance.now();
   const value=await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port,path:'/control/automations?contract=2'+query},response=>{
    let body='';response.on('data',x=>body+=x);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(body)}));
   }).on('error',reject));
   return {...value,ms:performance.now()-start};
  };
  const cold=await get();assert.ok(cold.ms<300,`cold ${cold.ms}`);assert.equal(cold.body.sections.automations.availability,'unavailable');assert.equal(cold.body.sections.automations.remainingFreshMs,0);assert.equal(cold.body.computation.deliveryMode,'deferred');
  await get();await delay(2300);
  const warm=await get();assert.ok(warm.ms<300,`warm ${warm.ms}`);assert.equal(warm.body.computation.deliveryMode,'cache');assert.equal(warm.body.sections.automations.data.items[0].id,'one');assert.ok(warm.body.sections.automations.remainingFreshMs>0&&warm.body.sections.automations.remainingFreshMs<=15000);
  await delay(30);const older=await get();assert.ok(older.body.sections.automations.remainingFreshMs<warm.body.sections.automations.remainingFreshMs);
  assert.equal((await fs.readFile(path.join(root,'calls'),'utf8')).trim().split('\n').length,2);
  const rev=warm.body.sections.automations.dataRevision;
  sql('UPDATE cron_jobs SET state_json=?,runtime_updated_at_ms=?',['{"lastRun":123}',123]);
  const clock=await get();assert.equal(clock.body.computation.deliveryMode,'cache');assert.equal(clock.body.sections.automations.dataRevision,rev);assert.ok(clock.ms<300);
  const healthyParallel=await Promise.all(Array.from({length:8},()=>get()));assert.ok(healthyParallel.every(x=>x.ms<300));
  assert.equal((await get('&knownRevision='+rev)).body.sections.automations.notModified,true);
  sql('UPDATE cron_jobs SET job_id=?',['two']);
  const changed=await get('&knownRevision='+rev);assert.ok(changed.ms<300);assert.equal(changed.body.computation.deliveryMode,'deferred');assert.ok(!changed.body.sections.automations.data);assert.ok(!changed.body.sections.automations.notModified);
  await delay(2500);assert.equal((await get()).body.sections.automations.data.items[0].id,'two');
  const forced=await get('&force=1');assert.equal(forced.body.computation.deliveryMode,'deferred');
  sql('UPDATE cron_jobs SET job_id=?',['three']);
  await delay(2500);
  const inFlightChanged=await get();assert.equal(inFlightChanged.body.computation.deliveryMode,'deferred');assert.ok(!inFlightChanged.body.sections.automations.data);
  await delay(2500);assert.equal((await get()).body.sections.automations.data.items[0].id,'three');
  await fs.unlink(source);await fs.symlink(path.join(root,'calls'),source);
  // S24 reality (OpenClaw 2026.9.6 keeps cron jobs in SQLite): no readable revision source means a normal read, never "deferred" forever.
  const unavailable=await get();assert.notEqual(unavailable.body.computation?.deliveryMode,'deferred');assert.equal(unavailable.body.sections.automations.data.items[0].id,'gateway');
  await fs.unlink(source);
  const missing=await get();assert.notEqual(missing.body.computation?.deliveryMode,'deferred');assert.equal(missing.body.sections.automations.data.items[0].id,'gateway');
  assert.ok(!JSON.stringify(warm.body).includes('synthetic-private-fixture'));
  console.log(JSON.stringify({test:'control-automations-latency',baselineMs:+baseline.toFixed(2),coldMs:+cold.ms.toFixed(2),cachedMs:+warm.ms.toFixed(2),source:'synthetic SQLite owner, attested columns, 2.4s slow computation; real DB capture pending',passed:true}));
 }finally{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  for(const [key,value] of [['OPENCLAW_STATE_DIR',saved.state],['SAMANTHA_CONTROL_PLAYBOOKS',saved.playbooks]])if(value===undefined)delete process.env[key];else process.env[key]=value;
  await fs.rm(root,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
