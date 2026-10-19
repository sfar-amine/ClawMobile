// HS2 GET /v1/catalog: derived view of the registry (HS1 catalog()) + installed route health + app surface view
// + payment owner gates. Inputs are real S24 sources (fixtures/s24-2026-10-11d/hs2-catalog-sources.json) and the
// HS1 projection computed from them (hs1-catalog-from-s24-sources.*.json, playbooks main b5b42a85).
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process');
const fixtures=path.join(__dirname,'../fixtures/s24-2026-10-11d');
const sources=JSON.parse(fs.readFileSync(path.join(fixtures,'hs2-catalog-sources.json'),'utf8'));
const hs1=Object.fromEntries(['fr','en'].map(l=>[l,JSON.parse(fs.readFileSync(path.join(fixtures,`hs1-catalog-from-s24-sources.${l}.json`),'utf8'))]));
const state=fs.mkdtempSync(path.join(os.tmpdir(),'hs2-catalog-'));process.env.OPENCLAW_STATE_DIR=state;
fs.mkdirSync(path.join(state,'capability-views'));fs.mkdirSync(path.join(state,'skill-intelligence'));
fs.writeFileSync(path.join(state,'capability-views/samantha_android.json'),JSON.stringify(sources.view));
fs.writeFileSync(path.join(state,'skill-intelligence/route-health.json'),JSON.stringify(sources.route_health));
process.env.SAMANTHA_CONTROL_PLAYBOOKS='/pinned-playbooks-test';
const S24_GENERATION_MS=360; // measured on the S24 (5 runs: 655 cold, then 360-363 ms)
let reads=0,forbidden=0,sourceFailed=false,lastGates=null;
cp.execFile=(command,args,options,callback)=>{
  if(command!=='python3'||args[0]!=='-c'||!String(args[1]).includes('from reporting.control_capability import catalog')){forbidden++;callback(Error('forbidden child'),'');return {};}
  assert.equal(options.cwd,process.env.SAMANTHA_CONTROL_PLAYBOOKS);
  assert.equal(args[3],path.join(state,'skill-intelligence/route-health.json'));
  lastGates=JSON.parse(args[4]);reads++;
  const timer=setTimeout(()=>sourceFailed?callback(Error('owner source unavailable'),''):callback(null,JSON.stringify(hs1[args[2]])),sourceFailed?20:S24_GENERATION_MS);
  options.signal?.addEventListener('abort',()=>{clearTimeout(timer);callback(Error('cancelled'),'')},{once:true});
  return {};
};
const client=require('../dist/companion/openclawAgentClient');client.callOpenClawGateway=()=>{forbidden++;throw Error('live gateway forbidden');};
const paymentsModule=require('../dist/companion/payments');
paymentsModule.payments.listPayables=()=>{forbidden++;throw Error('live payables forbidden');};
// Owner projection as served by GET /payments/capabilities when the Maxit gate file is present (capture: present=true, Topnet absent).
paymentsModule.payments.capabilities=()=>({schemaVersion:1,capability:'payment.owner_native',adapters:[
  {id:'maxit.topup',label:'Orange Maxit',mode:'live',executionValidated:false,localOwnerValidated:sources.gates['maxit.topup'].present,reasonCode:'maxit_live_acceptance_pending'},
  {id:'topnet',label:'Topnet',mode:'live',executionValidated:false,localOwnerValidated:true,reasonCode:'provider_payment_contract_unverified'}]});
for(const [file,name] of [['laptopAccess','laptopList'],['automations','allJobs']]){const mod=require('../dist/companion/'+file);if(typeof mod[name]==='function')mod[name]=()=>{forbidden++;throw Error('live owner forbidden');};}

const {catalogProjection,parseSurfaceView,ownerGateEvidence,resetCatalogCache}=require('../dist/companion/catalog');
const view=parseSurfaceView(sources.view);assert.ok(view);
const actionsOf=v=>v.themes.flatMap(t=>t.groups.flatMap(g=>g.actions));
// App contract (HomeCatalog.kt): no top-level availability/computation, voiceMemo object, usable = capability + request.
function appAdmits(v){
  assert.equal(v.version,1);assert.equal(v.availability,undefined);assert.equal(v.computation,undefined);
  // HS8 qualified by the 17/10 S24 receipt (memoSttBoundary): the composer microphone is announced.
  assert.deepEqual(v.inputs.voiceMemo,{available:true,availability:'available'});
  for(const a of actionsOf(v)){if(a.available){assert.ok(a.capability&&a.request);assert.equal(a.availability,'available');}else{assert.equal(a.request,null);assert.ok(['soon','unavailable'].includes(a.availability));}}
  for(const t of v.themes)assert.equal(t.available,t.groups.some(g=>g.actions.some(a=>a.available)));
}
for(const locale of ['fr','en']){
  const v=catalogProjection(hs1[locale],view);appAdmits(v);
  const acts=actionsOf(v);assert.equal(acts.length,80);assert.equal(acts.filter(a=>a.available).length,47);
  const byId=Object.fromEntries(acts.map(a=>[a.id,a]));
  assert.equal(byId['lines.orange.topup'].available,true); // gate armed by the owner projection
  assert.equal(byId['bills.topnet.pay'].available,false);assert.equal(byId['bills.topnet.pay'].reason,'acceptance_gate_unverified');
  assert.equal(byId['bills.steg.pay'].reason,'in_development');assert.equal(byId['bills.steg.pay'].availability,'soon');
  assert.ok(v.themes.find(t=>t.id==='wallets').availability==='soon'&&!v.themes.find(t=>t.id==='wallets').available);
  assert.ok(acts.filter(a=>['pay','transfer'].includes(a.kind)).every(a=>a.confirmationRequired===true));
  // Unknown reachability greys every backed action; a capability missing from the surface view is unreachable.
  const blind=catalogProjection(hs1[locale],null);appAdmits(blind);assert.equal(actionsOf(blind).filter(a=>a.available).length,0);
  assert.ok(actionsOf(blind).filter(a=>a.capability).every(a=>a.reason==='reachability_unknown'||a.reason==='acceptance_gate_unverified'||a.reason==='context_blocked'));
  const partial={...view,capabilities:view.capabilities.filter(c=>c.id!=='spotify.control')};
  const music=catalogProjection(hs1[locale],partial).themes.find(t=>t.id==='music');assert.equal(music.available,false);assert.equal(music.availability,'unavailable');
  assert.ok(music.groups[0].actions.every(a=>a.reason==='capability_unreachable'&&a.request===null));
  const blocked={...view,capabilities:view.capabilities.map(c=>c.id==='pulse.backend_first'?{...c,reachability:'unavailable'}:c)};
  assert.ok(actionsOf(catalogProjection(hs1[locale],blocked)).filter(a=>a.capability==='pulse.backend_first').every(a=>!a.available));
  // Forged or extra fields never become availability or leak.
  const forged=structuredClone(hs1[locale]);const steg=forged.themes[0].groups[0].actions[0];steg.available=true;steg.request='private request';steg.owner='private';forged.accountEmail='private@example.invalid';
  const fv=catalogProjection(forged,view);assert.ok(!JSON.stringify(fv).includes('private'));assert.equal(actionsOf(fv).find(a=>a.id===steg.id).available,false);
  const malformed=[s=>{s.themes[0].order={x:1};},s=>{s.generatedAt='2026-x';},s=>{s.defaultPinned=['unknown-theme'];},s=>{s.themes.push(structuredClone(s.themes[0]));},
    s=>{s.themes[0].groups[0].actions.push(structuredClone(s.themes[0].groups[0].actions[0]));},s=>{s.themes[0].groups[0].actions[0].title='a'.repeat(201);},s=>{s.themes[0].groups[0].actions[0].id='../escape';}];
  for(const mutate of malformed){const s=structuredClone(hs1[locale]);mutate(s);assert.throws(()=>catalogProjection(s,view),/catalog_source_unavailable/);}
}
// Gate evidence only from the owner projection.
assert.deepEqual(Object.keys(ownerGateEvidence({adapters:[{id:'maxit.topup',mode:'live',localOwnerValidated:true},{id:'topnet',mode:'live',localOwnerValidated:true}]})),['maxit.topup']);
assert.deepEqual(ownerGateEvidence({adapters:[{id:'maxit.topup',mode:'live',localOwnerValidated:false}]}),{});
assert.deepEqual(ownerGateEvidence(null),{});

(async()=>{
  const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const get=(headers={},method='GET',suffix='')=>new Promise((resolve,reject)=>{const start=performance.now();http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/catalog'+suffix,method,headers},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:raw?JSON.parse(raw):null,ms:performance.now()-start}));}).on('error',reject).end();});
  const p95=list=>list.map(r=>r.ms).sort((a,b)=>a-b)[Math.ceil(list.length*0.95)-1];
  try{
    for(const header of ['Origin','Referer','Sec-Fetch-Site'])assert.equal((await get({[header]:'cross-site'})).status,403);
    assert.equal((await get({},'POST')).status,405);assert.equal((await get({},'GET','?owner=true')).status,400);assert.equal((await get({},'GET','?locale=de')).status,400);
    assert.equal(reads,0);
    // First read after start waits for one shared generation; ten callers share it.
    const cold=await Promise.all(Array.from({length:10},()=>get({},'GET','?locale=fr')));assert.equal(reads,1);
    assert.ok(cold.every(r=>r.status===200&&r.body.themes.length===10));appAdmits(cold[0].body);
    assert.deepEqual(Object.keys(lastGates),['maxit.topup']);assert.equal(lastGates['maxit.topup'].source,'canonical_owner');
    const tag=cold[0].headers.etag;assert.ok(tag);assert.equal((await get({'If-None-Match':tag},'GET','?locale=fr')).status,304);
    const warm=await Promise.all(Array.from({length:40},()=>get({},'GET','?locale=fr')));assert.equal(reads,1);const warmP95=p95(warm);assert.ok(warmP95<300,'warm p95 '+warmP95);
    const en=await get({},'GET','?locale=en');assert.equal(en.status,200);assert.equal(en.body.locale,'en');assert.equal(en.headers['content-language'],'en');assert.equal(reads,2);
    assert.equal((await get({'Accept-Language':'en'})).body.locale,'en');assert.equal(reads,2);
    // Past the pool TTL the last projection is served at once while the pool recomputes it in the background.
    await new Promise(r=>setTimeout(r,15200));
    const stale=await Promise.all(Array.from({length:20},()=>get({},'GET','?locale=fr')));const staleP95=p95(stale);
    assert.ok(stale.every(r=>r.status===200&&r.body.themes));assert.ok(staleP95<300,'stale p95 '+staleP95);assert.equal(reads,3);
    await new Promise(r=>setTimeout(r,S24_GENERATION_MS+100));assert.equal((await get({},'GET','?locale=fr')).status,200);assert.equal(reads,3);
    // A failing source without any projection served yet answers 503, never invented entries.
    sourceFailed=true;process.env.SAMANTHA_CONTROL_PLAYBOOKS='/missing-playbooks';resetCatalogCache();
    const failed=await get({},'GET','?locale=fr');assert.equal(failed.status,503);assert.ok(!failed.headers.etag);assert.ok(!failed.body.themes);
    assert.equal(forbidden,0);
    console.log(JSON.stringify({suite:'hs2-catalog',s24Sources:true,generationMs:S24_GENERATION_MS,ownerReads:reads,forbiddenLiveReads:forbidden,coldMs:Math.round(cold[0].ms),warmP95Ms:Math.round(warmP95),staleP95Ms:Math.round(staleP95),availableActions:47}));
  }finally{await new Promise(r=>server.close(r));fs.rmSync(state,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
