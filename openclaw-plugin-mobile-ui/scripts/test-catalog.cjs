const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process');
const samples=Object.fromEntries(['fr','en'].map(l=>[l,JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/hs1-git-catalog',l+'.json'),'utf8'))]));
process.env.SAMANTHA_CONTROL_PLAYBOOKS='/git-pinned-catalog-test';
let reads=0,forbidden=0,sourceFailed=false;
// Owner boundary only; HTTP goes through the real route and existing ControlReadPool.
cp.execFile=(command,args,options,callback)=>{
 assert.equal(command,'python3');assert.deepEqual(args.slice(0,3),['-m','reporting.control_capability','--catalog']);assert.equal(options.cwd,process.env.SAMANTHA_CONTROL_PLAYBOOKS);
 reads++;const timer=setTimeout(()=>sourceFailed?callback(Error('owner source unavailable'),''):callback(null,JSON.stringify(samples[args[4]])),sourceFailed?50:2300);options.signal?.addEventListener('abort',()=>{clearTimeout(timer);callback(Error('cancelled'),'')},{once:true});
 return {};
};
const client=require('../dist/companion/openclawAgentClient');client.callOpenClawGateway=()=>{forbidden++;throw Error('live gateway forbidden');};
for(const [file,name] of [['payments','listPayables'],['laptopAccess','laptopList'],['automations','allJobs']]){
 const mod=require('../dist/companion/'+file);if(typeof mod[name]==='function')mod[name]=()=>{forbidden++;throw Error('live owner forbidden');};
}
const {catalogProjection}=require('../dist/companion/catalog');
for(const locale of ['fr','en']){
 const value=catalogProjection(samples[locale]);assert.equal(value.inputs.voiceMemo,false);assert.deepEqual(value.badges,[]);
 const actions=value.themes.flatMap(t=>t.groups.flatMap(g=>g.actions));assert.ok(actions.length>10);assert.ok(actions.some(a=>a.capability===null));
 assert.ok(actions.every(a=>!a.available&&a.request===null));assert.ok(actions.filter(a=>['pay','transfer'].includes(a.kind)).every(a=>a.confirmationRequired));
 assert.throws(()=>catalogProjection({...samples[locale],themes:[...samples[locale].themes,...Array(33).fill(samples[locale].themes[0])]}));
 const malformed=[
  source=>{source.themes[0].order={private:'must not be returned'};},
  source=>{source.generatedAt='2026-private';},
  source=>{source.defaultPinned=['unknown-theme'];},
  source=>{source.themes.push(structuredClone(source.themes[0]));},
  source=>{source.themes[0].groups.push(structuredClone(source.themes[0].groups[0]));},
  source=>{source.themes[0].groups[0].actions.push(structuredClone(source.themes[0].groups[0].actions[0]));},
  source=>{source.themes[0].groups[0].actions[0].slots=[{id:'amount',required:true},{id:'amount',required:true}];},
  source=>{source.themes[0].groups[0].actions[0].title='a'.repeat(201);},
  source=>{source.themes[0].groups[0].actions[0].id='../escape';},
  source=>{source.themes[0].groups[0].actions[0].slots=Array(9).fill({id:'a',required:true});},
 ];
 for(const mutate of malformed){const source=structuredClone(samples[locale]);mutate(source);assert.throws(()=>catalogProjection(source),/catalog_source_unavailable/);}
 const extra=structuredClone(samples[locale]);extra.owner=true;extra.gates={armed:true};extra.accountEmail='private@example.invalid';extra.badges=[{value:'private'}];extra.themes[0].private='hidden';const sanitized=catalogProjection(extra);assert.ok(!JSON.stringify(sanitized).includes('private'));assert.equal(sanitized.owner,undefined);assert.deepEqual(sanitized.badges,[]);
 const forged=structuredClone(samples[locale]);forged.themes[0].groups[0].actions[0].available=true;forged.themes[0].groups[0].actions[0].owner=true;assert.equal(catalogProjection(forged).themes[0].groups[0].actions[0].available,false);
}
(async()=>{
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(e=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const get=(headers={},method='GET',suffix='')=>new Promise((resolve,reject)=>{const start=performance.now();http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/catalog'+suffix,method,headers},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,raw,body:raw?JSON.parse(raw):null,ms:performance.now()-start}));}).on('error',reject).end();});
 try{
  for(const header of ['Origin','Referer','Sec-Fetch-Site'])assert.equal((await get({[header]:'cross-site','If-None-Match':'*'})).status,403);
  assert.equal((await get({},'POST')).status,405);assert.equal((await get({},'GET','?owner=true')).status,400);assert.equal(reads,0);
  const cold=await Promise.all(Array.from({length:10},()=>get()));assert.equal(reads,1);assert.ok(cold.every(r=>r.status===200&&r.ms<300&&r.body.availability==='unavailable'&&r.body.computation.deliveryMode==='deferred'&&!r.headers.etag&&!r.body.themes));
  // Production acceptance settle follows the same source flight; no catalogue datum exists before it completes.
  let ready;const settleStart=performance.now();do{await new Promise(r=>setTimeout(r,500));ready=await get();assert.ok(ready.ms<300);}while(ready.body.computation?.deliveryMode==='deferred'&&performance.now()-settleStart<15000);
  assert.ok(ready.body.themes);const readyAt=performance.now();const settleMs=performance.now()-settleStart;assert.equal(reads,1);const tag=ready.headers.etag;assert.ok(tag);assert.equal((await get({'If-None-Match':tag})).status,304);
  const warm=await Promise.all(Array.from({length:40},()=>get()));const p95=warm.map(r=>r.ms).sort((a,b)=>a-b)[37];assert.ok(p95<300,'warm p95 target '+p95);assert.equal(reads,1);
  const enCold=await get({'Accept-Language':'en','If-None-Match':tag});assert.equal(enCold.status,200);assert.ok(enCold.ms<300);assert.equal(enCold.body.computation.deliveryMode,'deferred');assert.ok(!enCold.headers.etag);
  await new Promise(r=>setTimeout(r,2400));const en=await get({'Accept-Language':'en','If-None-Match':tag});assert.equal(en.status,200);assert.equal(en.body.locale,'en');assert.notEqual(en.headers.etag,tag);assert.equal(en.headers['content-language'],'en');assert.equal(reads,2);assert.equal(forbidden,0);
  const denied=await get({Origin:'https://example.invalid','If-None-Match':tag});assert.equal(denied.status,403);assert.equal(reads,2);
  // The actual existing Control TTL expires; a new shared read must not serve a stale positive projection.
  await new Promise(r=>setTimeout(r,Math.max(0,15100-(performance.now()-readyAt))));
  const expired=await Promise.all(Array.from({length:10},()=>get({'If-None-Match':tag})));assert.equal(reads,3);assert.ok(expired.every(r=>r.status===200&&r.ms<300&&r.body.computation?.deliveryMode==='deferred'&&!r.headers.etag&&!r.body.themes));
  await new Promise(r=>setTimeout(r,2400));const reread=await get();assert.equal(reread.status,200);assert.ok(reread.body.themes);assert.equal(reads,3);
  sourceFailed=true;process.env.SAMANTHA_CONTROL_PLAYBOOKS='/git-pinned-missing-catalog';const failed=await get({'If-None-Match':tag});assert.equal(failed.status,503);assert.ok(failed.ms<300);assert.ok(!failed.headers.etag);assert.ok(!failed.body.themes);assert.equal(reads,4);
  console.log(JSON.stringify({tests:'catalog projection + HTTP guards/cache/locales',ownerReads:reads,forbiddenLiveReads:forbidden,warmP95Ms:p95,coldMs:cold[0].ms,settleMs,physicalQualification:false,badgesQualified:false}));
 }finally{await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
