const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {performance}=require('node:perf_hooks');
const {readControl,handleControl}=require('../dist/companion/control');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'automation-latency-'));
 const saved={state:process.env.OPENCLAW_STATE_DIR,playbooks:process.env.SAMANTHA_CONTROL_PLAYBOOKS};
 let server;
 try{
  await fs.mkdir(path.join(root,'cron'));await fs.mkdir(path.join(root,'reporting'));
  const source=path.join(root,'cron/jobs.json');
  await fs.writeFile(source,JSON.stringify({version:1,jobs:[{id:'one'}],secret:'must-not-cross-boundary'}));
  await fs.writeFile(path.join(root,'reporting/__init__.py'),'');
  await fs.writeFile(path.join(root,'reporting/control_snapshot.py'),`import json,time,os,hashlib\nfrom pathlib import Path\nr=Path(os.environ['OPENCLAW_STATE_DIR'])\nwith (r/'calls').open('a') as f:f.write('call\\n')\ntry:data=json.loads((r/'cron/jobs.json').read_text())\nexcept Exception:data={'jobs':[{'id':'gateway'}]}\ntime.sleep(1.84)\nitems=[{'id':x['id']} for x in data['jobs']]\nrevision=hashlib.sha256(json.dumps(items).encode()).hexdigest()\nprint(json.dumps({'schemaVersion':2,'sections':{'automations':{'schemaVersion':2,'resourceKey':'control/v2/automations','dataRevision':revision,'availability':'ready','freshness':'fresh','remainingFreshMs':15000,'data':{'items':items,'available':True}}}}))\n`);
  process.env.OPENCLAW_STATE_DIR=root;process.env.SAMANTHA_CONTROL_PLAYBOOKS=root;
  const began=performance.now();await readControl('automations');const baseline=performance.now()-began;
  assert.ok(baseline>=1840);
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
  await get();await delay(1700);
  const warm=await get();assert.ok(warm.ms<300,`warm ${warm.ms}`);assert.equal(warm.body.computation.deliveryMode,'cache');assert.equal(warm.body.sections.automations.data.items[0].id,'one');assert.ok(warm.body.sections.automations.remainingFreshMs>0&&warm.body.sections.automations.remainingFreshMs<=15000);
  await delay(30);const older=await get();assert.ok(older.body.sections.automations.remainingFreshMs<warm.body.sections.automations.remainingFreshMs);
  assert.equal((await fs.readFile(path.join(root,'calls'),'utf8')).trim().split('\n').length,2);
  const rev=warm.body.sections.automations.dataRevision;
  assert.equal((await get('&knownRevision='+rev)).body.sections.automations.notModified,true);
  await fs.writeFile(source,JSON.stringify({version:1,jobs:[{id:'two'}]}));
  const changed=await get('&knownRevision='+rev);assert.ok(changed.ms<300);assert.equal(changed.body.computation.deliveryMode,'deferred');assert.ok(!changed.body.sections.automations.data);assert.ok(!changed.body.sections.automations.notModified);
  await delay(1800);assert.equal((await get()).body.sections.automations.data.items[0].id,'two');
  const forced=await get('&force=1');assert.equal(forced.body.computation.deliveryMode,'deferred');
  await fs.writeFile(source,JSON.stringify({version:1,jobs:[{id:'three'}]}));
  await delay(1800);
  const inFlightChanged=await get();assert.equal(inFlightChanged.body.computation.deliveryMode,'deferred');assert.ok(!inFlightChanged.body.sections.automations.data);
  await delay(1800);assert.equal((await get()).body.sections.automations.data.items[0].id,'three');
  await fs.unlink(source);await fs.symlink(path.join(root,'calls'),source);
  // S24 reality (OpenClaw 2026.9.6 keeps cron jobs in SQLite): no readable revision source means a normal read, never "deferred" forever.
  const unavailable=await get();assert.notEqual(unavailable.body.computation?.deliveryMode,'deferred');assert.equal(unavailable.body.sections.automations.data.items[0].id,'gateway');
  await fs.unlink(source);
  const missing=await get();assert.notEqual(missing.body.computation?.deliveryMode,'deferred');assert.equal(missing.body.sections.automations.data.items[0].id,'gateway');
  assert.ok(!JSON.stringify(warm.body).includes('must-not-cross-boundary'));
  console.log(JSON.stringify({test:'control-automations-latency',baselineMs:+baseline.toFixed(2),coldMs:+cold.ms.toFixed(2),cachedMs:+warm.ms.toFixed(2),source:'offline slow-owner fixture',passed:true}));
 }finally{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  for(const [key,value] of [['OPENCLAW_STATE_DIR',saved.state],['SAMANTHA_CONTROL_PLAYBOOKS',saved.playbooks]])if(value===undefined)delete process.env[key];else process.env[key]=value;
  await fs.rm(root,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
