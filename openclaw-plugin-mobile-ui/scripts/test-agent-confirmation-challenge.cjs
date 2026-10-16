// H4: genuine HTTP + R6 owner projection, using real sanitized S24 config/auth/catalog.
// The two configuration variations are explicit regression cases, not S24 captures.
const cp=require('node:child_process');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
(async()=>{
 const reportScript=path.resolve(__dirname,'runtime-contract-report.py');
 const budgets=JSON.parse(cp.execFileSync('python3',['-c','import importlib.util,json,sys; s=importlib.util.spec_from_file_location("g2",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.read_budgets()))',reportScript],{encoding:'utf8'}));
 const challengeBudgetMs=budgets['/v1/agent/config']*1000;assert.ok(Number.isFinite(challengeBudgetMs));
 const fixtureRoot=path.resolve(__dirname,'../fixtures/s24-2026-10-10/ui-recette');
 const load=async name=>JSON.parse(await fs.readFile(path.join(fixtureRoot,name),'utf8'));
 const [configCapture,catalogCapture,authCapture]=await Promise.all(['gateway.config.get.json','gateway.models.list.json','gateway.models.authStatus.json'].map(load));
 assert.ok(configCapture.response.config.agents.entries.main);assert.ok(authCapture.response.providers.some(row=>row.profiles?.length));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'h4-confirmation-'));process.env.OPENCLAW_STATE_DIR=root;await fs.mkdir(path.join(root,'clawmobile-companion'));const registry=path.join(root,'clawmobile-companion/runs.json');await fs.writeFile(registry,JSON.stringify({version:1,runs:[],archivedSessionIds:[],paymentRequests:[],ownerConfirmations:[]}));
 let raw=structuredClone(configCapture.response),patchAttempts=0,consumed=0,consumeAttempts=0,proofMode='valid',expectedHash;
 const calls=[];require('../dist/companion/openclawAgentClient').callOpenClawGateway=async(method,params)=>{
  if(method==='config.patch'){patchAttempts++;throw Object.assign(Error('ECONNREFUSED'),{code:'ECONNREFUSED'});}
  const capture=method==='config.get'?configCapture:method==='models.list'?catalogCapture:method==='models.authStatus'?authCapture:null;
  if(method==='sessions.list')throw Object.assign(Error('Not required for model-specific thinking levels'),{code:'FIXTURE_NOT_USED'});
  assert.ok(capture,'No fabricated Gateway method');const began=performance.now();await new Promise(resolve=>setTimeout(resolve,capture._capture.latencyMs));calls.push({method,elapsedMs:performance.now()-began,latencyMs:capture._capture.latencyMs});return structuredClone(method==='config.get'?raw:capture.response);
 };
 const confirmationApi=require('../dist/companion/confirmations').confirmations;
 confirmationApi.status=async()=>{if(proofMode==='expired')throw Object.assign(Error('confirmation_not_usable'),{statusCode:409});return {intent:{presentation:{title:'Configuration',subtitle:'Agent',description:'Extension de secours'},origin:{channel:'samantha',id:'owner'}}};};
 confirmationApi.consume=async(id,intent)=>{consumeAttempts++;assert.equal(intent.action.type,'agent.config.expand_fallbacks');assert.equal(intent.action.reference,'main');assert.equal(intent.action.payloadHash,expectedHash,'Challenge and canonical consume must use exactly the same hash');if(proofMode==='mismatch')throw Object.assign(Error('confirmation_scope_mismatch'),{statusCode:403});assert.equal(id,'approved-fixture');consumed++;return {consumed:true};};
 function request(body,owner=true){const began=performance.now();return new Promise((resolve,reject)=>{const bytes=JSON.stringify(body);const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/v1/agent/config',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(bytes),...(owner?{'x-clawmobile-owner-flow':'v1'}:{})}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({code:res.statusCode,body:JSON.parse(text),elapsedMs:performance.now()-began}));});req.on('error',reject);req.end(bytes);});}
 const account=require('../dist/companion/accountIdentity');
 const primary=catalogCapture.response.models.find(row=>row.provider==='openai'&&row.available&&row.thinkingLevels?.some(x=>x.id==='low'));assert.ok(primary);
 const provider=authCapture.response.providers.find(row=>row.provider==='google'&&row.profiles?.some(x=>['ok','static','expiring'].includes(x.status)));const profile=provider.profiles.find(x=>['ok','static','expiring'].includes(x.status));
 const fallbackModel=catalogCapture.response.models.find(row=>row.provider===provider.provider&&row.available);assert.ok(fallbackModel);
 const profileRef=account.publicModelRef(provider.provider+'/'+fallbackModel.id+'@'+profile.profileId);
 const base={provider:primary.provider,model:primary.id,thinking:'low',revision:raw.hash};
 const hash=body=>crypto.createHash('sha256').update(JSON.stringify({provider:body.provider,model:body.model,thinking:body.thinking,revision:body.revision,fallbacks:body.fallbacks})).digest('hex');
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  // An entry exists but its model has no explicit fallbacks; app has echoed defaults.
  delete raw.config.agents.entries.main.model.fallbacks;
  const inherited=raw.config.agents.defaults.model.fallbacks;assert.ok(inherited.length);const inheritedBody={...base,provider:fallbackModel.provider,model:fallbackModel.id,operationId:'h4-inherited',fallbacks:inherited.map(ref=>account.publicModelRef(ref))};
  const before=await fs.readFile(registry,'utf8');const challenged=await request(inheritedBody);assert.equal(challenged.code,403);assert.ok(challenged.elapsedMs>=configCapture._capture.latencyMs-2&&challenged.elapsedMs<challengeBudgetMs);assert.deepEqual(challenged.body,{success:false,state:'refused',receipt:null,error:'confirmation_required',scope:'agent.config.expand_fallbacks',reference:'main',payloadHash:hash(inheritedBody)});assert.equal(await fs.readFile(registry,'utf8'),before);assert.equal(patchAttempts,0);assert.equal(consumed,0);
  raw=structuredClone(configCapture.response);raw.config.agents.entries.main.model.fallbacks=[];
  const newProfile={...base,operationId:'h4-new-profile',fallbacks:[profileRef]};const noOwner=await request(newProfile,false);assert.equal(noOwner.code,403);assert.equal(noOwner.body.payloadHash,undefined,'No challenge before owner admission');
  const required=await request(newProfile);assert.equal(required.code,403);assert.ok(required.elapsedMs>=configCapture._capture.latencyMs-2&&required.elapsedMs<challengeBudgetMs);expectedHash=hash(newProfile);assert.equal(required.body.payloadHash,expectedHash);assert.equal(required.body.scope,'agent.config.expand_fallbacks');assert.equal(required.body.reference,'main');assert.ok(!JSON.stringify(required.body).includes(profile.profileId));assert.equal(patchAttempts,0);assert.equal(consumed,0);
  proofMode='mismatch';const mismatch=await request({...newProfile,confirmationId:'wrong-fixture'});assert.equal(mismatch.code,403);assert.equal(mismatch.body.error,'confirmation_scope_mismatch');assert.equal(patchAttempts,0);assert.equal(consumed,0);
  proofMode='expired';const expired=await request({...newProfile,confirmationId:'expired-fixture'});assert.equal(expired.code,409);assert.equal(patchAttempts,0);
  proofMode='valid';const approved=await request({...newProfile,confirmationId:'approved-fixture'});assert.equal(approved.code,200);assert.equal(approved.body.state,'failed','No successful config.patch capture is invented');assert.equal(consumed,1);assert.equal(patchAttempts,1);assert.equal(consumeAttempts,2);
  // A profile already explicitly configured must keep the existing R6 behavior.
  raw=structuredClone(configCapture.response);const previousProfiles=raw.config.agents.entries.main.model.fallbacks.map(ref=>account.publicModelRef(ref));const oldProfile=await request({...base,operationId:'h4-existing-profile',fallbacks:previousProfiles});assert.equal(oldProfile.code,200);assert.equal(oldProfile.body.state,'failed');assert.equal(consumed,1);assert.equal(patchAttempts,2);
  const state=JSON.parse(await fs.readFile(registry,'utf8'));state.paymentRequests=[{state:'requires_bank_action'}];await fs.writeFile(registry,JSON.stringify(state));const guarded=await fs.readFile(registry,'utf8');const bank=await request({...base,operationId:'h4-bank',fallbacks:[profileRef]});assert.equal(bank.code,409);assert.equal(bank.body.payloadHash,undefined);assert.equal(await fs.readFile(registry,'utf8'),guarded);assert.equal(consumed,1);assert.equal(patchAttempts,2);
  for(const row of calls)assert.ok(row.elapsedMs>=row.latencyMs-2);
  console.log(JSON.stringify({lot:'H4',cases:['inherited_defaults','new_profile','existing_profile_unchanged','owner_admission','mismatch','expired','exact_hash_consume_before_dispatch','bank_guard_unchanged'],calls:calls.length,configCaptureLatencyMs:configCapture._capture.latencyMs,challengeHttpMs:[challenged.elapsedMs,required.elapsedMs],challengeBudgetMs,patchAttempts,successfulEffects:0}));
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error.stack);process.exitCode=1});
