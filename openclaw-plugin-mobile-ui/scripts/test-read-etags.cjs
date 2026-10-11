const assert=require('node:assert/strict'),fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),{performance}=require('node:perf_hooks'),crypto=require('node:crypto'),cp=require('node:child_process');
const dir=path.join(__dirname,'../fixtures/s24-2026-10-10'),captured=name=>JSON.parse(sync.readFileSync(path.join(dir,'gateway',name+'.json'))),delay=ms=>new Promise(r=>setTimeout(r,ms));
const acceptance=path.resolve(__dirname,'../../installer/termux-lite/companion-acceptance.py');
const budgets=Object.fromEntries(JSON.parse(cp.execFileSync('python3',['-c',"import ast,json,sys; t=ast.parse(open(sys.argv[1]).read()); print(json.dumps(next(ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='READS' for x in n.targets))))",acceptance],{encoding:'utf8'})));
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'i1-etags-'));process.env.OPENCLAW_STATE_DIR=root;process.env.SAMANTHA_CONTROL_PLAYBOOKS=root;process.env.SAMANTHA_CONTROL_CACHE='1';
 await fs.mkdir(path.join(root,'clawmobile-companion'));const registry=JSON.parse(sync.readFileSync(path.join(dir,'i1/native-runs-registry.json')));assert.equal(registry._capture.sanitized,true);
 const registryPath=path.join(root,'clawmobile-companion/runs.json');await fs.writeFile(registryPath,JSON.stringify(registry.response));
 const native=JSON.parse(sync.readFileSync(path.join(dir,'i1/native-automations.json')));assert.equal(native._capture.sanitized,true);
 await fs.mkdir(path.join(root,'reporting'));await fs.writeFile(path.join(root,'reporting/__init__.py'),'');await fs.writeFile(path.join(root,'native.json'),JSON.stringify(native.response));
 await fs.writeFile(path.join(root,'reporting/control_snapshot.py'),`import time\nfrom pathlib import Path\ntime.sleep(${native._capture.latencyMs/1000})\nprint((Path(__file__).parent.parent/'native.json').read_text())\n`);
 const methods={};for(const name of ['config.get','models.list','models.authStatus','sessions.list','usage.status','agents.files.list','agents.files.get'])methods[name]=captured(name);
 methods['config.get'].response=JSON.parse(sync.readFileSync(path.join(dir,'ui-recette/gateway.config.get.json'))).response;
 const usageTotals=JSON.parse(sync.readFileSync(path.join(dir,'p0-3/sessions.usage.json'))).response;
 let now=Date.now(),changedUsage=false;const dateNow=Date.now;Date.now=()=>now;const counts={};
 require('../dist/companion/openclawAgentClient').callOpenClawGateway=async(method,params)=>{
  counts[method]=(counts[method]||0)+1;
  if(method==='sessions.usage')return structuredClone(usageTotals);
  const fixture=methods[method];assert.ok(fixture,'unexpected owner '+method);await delay(fixture._capture?.latencyMs||3200);
  const value=structuredClone(fixture.response);
  if(method==='usage.status'&&changedUsage){value.providers[0].windows[0].usedPercent=12;value.updatedAt+=60001;}
  if(method==='agents.files.get'&&params.name!==value.file.name)return {agentId:'main',workspace:value.workspace,file:{name:params.name,path:value.workspace+'/'+params.name,missing:true}};
  return value;
 };
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(url,headers={},method='GET')=>new Promise((resolve,reject)=>{const begin=process.hrtime.bigint(),req=http.request({host:'127.0.0.1',port:server.address().port,path:url,headers,method},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{const raw=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,raw,body:raw?JSON.parse(raw):null,ms:Number(process.hrtime.bigint()-begin)/1e6});});});req.on('error',reject);req.end();});
 function strong(view){assert.equal(view.status,200);assert.match(view.headers.etag,/^"[a-f0-9]{64}"$/);assert.equal(view.headers.etag,'"'+crypto.createHash('sha256').update(view.raw).digest('hex')+'"');}
 const transport=[];
 async function unchanged(url){const budget=budgets[url.replace(/^\/v1/,'')]*1000;assert(Number.isFinite(budget));const a=await request(url);strong(a);const b=await request(url,{'If-None-Match':a.headers.etag});assert.equal(b.status,304,url);assert.equal(b.raw,'');assert.equal(b.headers['content-length'],undefined);assert.equal(b.headers.etag,a.headers.etag);assert.ok(a.ms<budget&&b.ms<budget,url+' budget');transport.push({route:url,budgetMs:budget,firstMs:Math.round(a.ms),conditionalMs:Math.round(b.ms),bytesAvoided:Buffer.byteLength(a.raw)});return a;}
 try{
  // Existing R6 owner: actual config/model/auth captures, 4.766 s realistic cold calls.
  const config=await unchanged('/v1/agent/config');assert.equal(config.body.success,true);
  await unchanged('/v1/providers');const usage=await unchanged('/v1/usage');
  const beforeShared=JSON.stringify(counts);const simultaneous=await Promise.all(Array.from({length:10},()=>request('/v1/usage',{'If-None-Match':usage.headers.etag})));assert(simultaneous.every(x=>x.status===304&&x.raw===''));assert.equal(JSON.stringify(counts),beforeShared,'ETag adds no owner calls/cache');
  // Stale-while-revalidate (11/10 perf): the expired minute answers the held view at once (unchanged, 304), and the
  // revalidated quotas carry a new strong ETag on the next read.
  changedUsage=true;now+=60001;const held=await request('/v1/usage',{'If-None-Match':usage.headers.etag});assert.equal(held.status,304);assert.ok(held.ms<500,'held view answers without the CLI read');
  await delay((methods['usage.status']._capture?.latencyMs||3200)+150);
  const changed=await request('/v1/usage',{'If-None-Match':usage.headers.etag});strong(changed);assert.notEqual(changed.headers.etag,usage.headers.etag);
  // Real terminal registry subset, owner sessions.list remains behind the R11 cache.
  const runs=await unchanged('/v1/runs?contract=2&view=conversations&limit=20');const data=JSON.parse(await fs.readFile(registryPath));data.runs[0].result='Declared test variation: latest visible result';await fs.writeFile(registryPath,JSON.stringify(data));
  const changedRuns=await request('/v1/runs?contract=2&view=conversations&limit=20',{'If-None-Match':runs.headers.etag});strong(changedRuns);assert.notEqual(changedRuns.headers.etag,runs.headers.etag);
  // Files uses its existing 50 ms deferred response while the owner settles.
  const pending=await request('/v1/files?scope=agent',{'If-None-Match':'*'});assert.equal(pending.status,200);assert.equal(pending.body.computation.deliveryMode,'deferred');assert.equal(pending.headers.etag,undefined);
  await delay(methods['agents.files.list']._capture.latencyMs+150);await unchanged('/v1/files?scope=agent');
  // Native Control output, not a synthetic HTTP response injected as its owner.
  const {readControlV2}=require('../dist/companion/control');await readControlV2(['automations']);
  // Controlled age is used only to assert exact unchanged-body semantics, then changed TTL.
  const descriptor=Object.getOwnPropertyDescriptor(performance,'now');let frozen=performance.now();Object.defineProperty(performance,'now',{configurable:true,value:()=>frozen});
  try{const a=await unchanged('/v1/control/automations?contract=2');frozen+=25;const aged=await request('/v1/control/automations?contract=2',{'If-None-Match':a.headers.etag});strong(aged);assert.notEqual(aged.headers.etag,a.headers.etag,'TTL change is a changed representation, never weakly ignored');}
  finally{if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete performance.now;}
  for(const url of ['/v1/agent/config','/v1/providers','/v1/usage','/v1/files?scope=agent','/v1/control/automations?contract=2','/v1/runs?contract=2&view=conversations']){
   for(const headers of [{Origin:'https://cross.invalid'},{Referer:'https://cross.invalid'},{'Sec-Fetch-Site':'cross-site'}]){const r=await request(url,{...headers,'If-None-Match':'*'});assert.equal(r.status,403,url);assert.equal(r.headers.etag,undefined);}
   const invalid=await request(url.startsWith('/v1/runs')?'/v1/runs?contract=2&view=conversations&limit=0':url+(url.includes('?')?'&':'?')+'unsupported=1',{'If-None-Match':'*'});assert.notEqual(invalid.status,304,url);
  }
  const mutation=await request('/v1/agent/config',{'If-None-Match':'*'},'POST');assert.equal(mutation.status,403);assert.equal(mutation.headers.etag,undefined);
  const badState={success:false,state:'refused'};const {conditionalRead}=require('../dist/companion/readEtag');const fakeReq={method:'GET',url:'/v1/usage',socket:{remoteAddress:'127.0.0.1'},headers:{'if-none-match':'*'}};assert.equal(conditionalRead(fakeReq,{setHeader(){throw Error('must not decorate refusal');}},200,badState,JSON.stringify(badState)),false);
  for(const value of [{computation:{deliveryMode:'deferred'}},{cost:{state:'computing'}},{sections:{automations:{availability:'unavailable'}}}])assert.equal(conditionalRead(fakeReq,{setHeader(){throw Error('must not decorate incomplete projection');}},200,value,JSON.stringify(value)),false);
  for(const req of [{...fakeReq,method:'POST'},{...fakeReq,socket:{remoteAddress:'192.0.2.1'}},{...fakeReq,url:'/v1/payments'},{...fakeReq,url:'/v1/files/content?scope=agent&path=AGENTS.md'}])assert.equal(conditionalRead(req,{setHeader(){throw Error('outside read scope');}},200,usage.body,usage.raw),false);
  for(const header of ['W/'+usage.headers.etag,'"different", '+usage.headers.etag]){let ended=false;const response={setHeader(){},removeHeader(){},end(body){assert.equal(body,undefined);ended=true;}};assert.equal(conditionalRead({...fakeReq,headers:{'if-none-match':header}},response,200,usage.body,usage.raw),true);assert(ended);assert.equal(response.statusCode,304);}
  for(const header of ['malformed',usage.headers.etag+', *','x'.repeat(4097)])assert.equal(conditionalRead({...fakeReq,headers:{'if-none-match':header}},{setHeader(){},end(){throw Error('invalid header must not become304');}},200,usage.body,usage.raw),false);

  console.log(JSON.stringify({suite:'I1-exact-read-etags',routes:6,realCaptureBoundaries:true,sequence:'200/304/200 after owner and TTL changes',filesDeferredReturned304:false,transport,ownerCalls:counts,physicalQualification:false}));
 }finally{Date.now=dateNow;server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
