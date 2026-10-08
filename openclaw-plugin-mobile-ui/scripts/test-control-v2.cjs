const assert=require('node:assert/strict');
const http=require('node:http');
const {ControlReadPool,handleControl}=require('../dist/companion/control');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const result=()=>({schemaVersion:2,sections:{health:{schemaVersion:2,resourceKey:'control/v2/health',dataRevision:'a'.repeat(64),availability:'ready',freshness:'fresh',remainingFreshMs:1000,data:{state:'healthy'}}}});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
const request=(port,path,headers={},method='GET')=>new Promise((resolve,reject)=>{
 const req=http.request({host:'127.0.0.1',port,path,headers,method},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body}));});req.once('error',reject);req.end();
});
(async()=>{
 let count=0;const p=new ControlReadPool();const d=deferred();const generate=()=>{count++;return d.promise};
 const a=p.read('same',generate),b=p.read('same',generate),c=p.read('same',generate);d.resolve(result());
 const [ra,rb,rc]=await Promise.all([a,b,c]);
 assert.equal(count,1);assert.equal(rb.computation.deliveryMode,'coalesced');assert.equal(ra.computation.computationId,rc.computation.computationId);
 rb.sections.health.data.state='mutated';assert.equal(ra.sections.health.data.state,'healthy');
 assert.equal(p.stats().active,0);
 const d2=deferred(),left=new AbortController();let aborted=false;
 const gen=signal=>{signal.addEventListener('abort',()=>{aborted=true;d2.reject(Error('cancelled'));});return d2.promise};
 const first=p.read('cancel-one',gen,left.signal).catch(e=>e.message);
 const survivor=p.read('cancel-one',gen);left.abort();assert.equal(await first,'control_read_cancelled');assert.equal(aborted,false);
 d2.resolve(result());await survivor;
 const all=new AbortController();const cancelled=p.read('cancel-all',signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')))),all.signal).catch(e=>e.message);
 all.abort();assert.equal(await cancelled,'control_read_cancelled');await pause(1);assert.equal(p.stats().active,0);
 const d3=deferred();const old=p.read('invalidated',()=>d3.promise,undefined,{cache:true}).catch(e=>e.message);
 p.invalidate('invalidated');d3.resolve(result());assert.equal(await old,'control_invalidated');await pause(1);assert.equal(p.stats().cacheKeys,0);
 let cachedCalls=0;const cacheGen=async()=>{cachedCalls++;return result()};
 await p.read('cached',cacheGen,undefined,{cache:true});await pause(15);
 const hit=await p.read('cached',cacheGen,undefined,{cache:true});assert.equal(cachedCalls,1);assert.equal(hit.computation.deliveryMode,'cache');assert.ok(hit.sections.health.remainingFreshMs<1000);
 await p.read('cached',cacheGen,undefined,{cache:true,force:true});assert.equal(cachedCalls,2);
 const bounded=new ControlReadPool(100,2,3,500);let active=0,max=0;
 const slow=async()=>{active++;max=Math.max(max,active);await pause(15);active--;return result()};
 await Promise.all([bounded.read('a',slow),bounded.read('b',slow),bounded.read('c',slow)]);assert.equal(max,2);
 const budget=new ControlReadPool(20);const timeout=await budget.read('long',s=>new Promise((_,reject)=>s.addEventListener('abort',()=>reject(Error('abort'))))).catch(e=>e.message);
 assert.equal(timeout,'control_budget_exceeded');await pause(1);assert.equal(budget.stats().active,0);
 const small=new ControlReadPool(100,2,2,100);
 await small.read('oversize',async()=>result(),undefined,{cache:true});assert.equal(small.stats().cacheKeys,0);
 const server=http.createServer(async(req,res)=>{if(!await handleControl(req,res,req.url)){res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 try{
  assert.equal((await request(port,'/control/health?contract=2',{Origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await request(port,'/control/health?contract=2',{},'POST')).status,405);
  assert.equal((await request(port,'/control/health?contract=2&actor=owner')).status,400);
  assert.equal((await request(port,'/control/snapshot?contract=2&sections=bad')).status,400);
  const r=await request(port,'/control/health?contract=2');assert.equal(r.status,200);
  const data=JSON.parse(r.body);assert.equal(data.schemaVersion,2);assert.deepEqual(Object.keys(data.computation.sources),['health']);
  assert.equal(data.sections.health.resourceKey,'control/v2/health');assert.ok(data.sections.health.data);
  const legacy=await request(port,'/control/health');assert.equal(legacy.status,200);assert.ok('fresh' in JSON.parse(legacy.body));
  const detail=await request(port,'/control/requests/REQ-999999?contract=2');assert.equal(detail.status,200);
  assert.equal(JSON.parse(detail.body).sections.requests.data.found,false);
  const missions=await request(port,'/control/missions?contract=2');assert.equal(missions.status,200);
  const missionData=JSON.parse(missions.body);assert.equal(missionData.sections.missions.resourceKey,'control/v2/missions');
  assert.ok(Array.isArray(missionData.sections.missions.data.items));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 console.log(JSON.stringify({suite:'control-v2',checks:22,passed:true,pool:p.stats()}));
})().catch(e=>{console.error(e);process.exitCode=1});
