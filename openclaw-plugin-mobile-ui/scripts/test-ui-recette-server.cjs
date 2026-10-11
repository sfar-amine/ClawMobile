// Recette UI 10/10 (S24, Companion 9cdd84f): server-side defects, on the real sanitized captures
// of fixtures/s24-2026-10-10/ui-recette (see its README). Local injected latency only.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),fss=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const dir=path.join(__dirname,'../fixtures/s24-2026-10-10/ui-recette');
const fixture=name=>JSON.parse(fss.readFileSync(path.join(dir,name+'.json'),'utf8'));
const EMAIL=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i;
const RAW_PROFILE=/@(?:openai|google|github-copilot|custom-po-zapro-su):/;
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ui-recette-'));process.env.OPENCLAW_STATE_DIR=root;
 const historical=fixture('companion.metadata-historical')._capture.route.split('/')[3];
 const registry=path.join(root,'clawmobile-companion/runs.json');await fs.mkdir(path.dirname(registry));
 // Retained rows: the captured shapes (session ids, JSON tool results), synthetic values in place of the masked ones.
 const runs=[
  {runId:'run_1791648877631_9bc4ab68',sessionId:'decision-v2-live-5a66bfd3a1',text:'Bonjour',userText:'Bonjour',result:'Réponse texte normale',acceptedAt:1791648877631,updatedAt:1791648951945,state:'done'},
  {runId:'run_1791621662404_bdd2548c',sessionId:historical,text:'Batterie ?',userText:'Batterie ?',result:JSON.stringify({ok:true,provider:'termux',workflow:'battery',state:null,source:'samantha-native-bridge',transport:'local-http',ui_used:false,details:{owner:'owner@example.invalid'}}),acceptedAt:1791621662404,updatedAt:1791621668937,state:'done'},
  {runId:'run_1791497769857_1b41ff5d',sessionId:'decisionv2-live-read-1791497769',text:'Niveau batterie',userText:'Niveau batterie',result:JSON.stringify({ok:true,state:'completed',operation:'battery',level_percent:38,charging:false,plugged:false}),acceptedAt:1791497769857,updatedAt:1791497771283,state:'done'},
  {runId:'run_1791497000000_failed',sessionId:'decisionv2-live-fail-1791497000',text:'Paiement',userText:'Paiement',result:JSON.stringify({ok:false,error:'denied',amount:42,phone:'+21600000000',url:'https://example.invalid/x'}),acceptedAt:1791497000000,updatedAt:1791497000001,state:'done'}
 ];
 await fs.writeFile(registry,JSON.stringify({version:1,runs,archivedSessionIds:[],paymentRequests:[],ownerConfirmations:[]}));
 const gwConfig=fixture('gateway.config.get').response,catalog=fixture('gateway.models.list').response,auth=fixture('gateway.models.authStatus').response;
 const defaults=fixture('gateway.sessions.list.limit1').response,companionSessions=fixture('gateway.sessions.list.companion').response;
 // The capture keeps 4 of 31 rows: the trimmed page is complete for the test.
 const ownerPage={...companionSessions,count:companionSessions.sessions.length,totalCount:companionSessions.sessions.length};
 let config=structuredClone(gwConfig.config),hash=gwConfig.hash,patches=[],sessionPatches=[],counts={},now=Date.now(),ownerFail=false;
 const realNow=Date.now;Date.now=()=>now;
 const merge=(into,patch)=>{for(const [key,value] of Object.entries(patch)){if(value&&typeof value==='object'&&!Array.isArray(value)){into[key]||={};merge(into[key],value);}else into[key]=value;}};
 const client=require('../dist/companion/openclawAgentClient');
 client.callOpenClawGateway=async(method,params)=>{
  counts[method]=(counts[method]||0)+1;
  if(['config.get','models.list','models.authStatus'].includes(method)&&ownerFail)throw Error('owner restarting');
  if(method==='config.get')return {config:structuredClone(config),hash};
  if(method==='models.list')return structuredClone(catalog);
  if(method==='models.authStatus')return structuredClone(auth);
  if(method==='sessions.usage')return {totals:{totalTokens:51057412,totalCost:1.25}};
  if(method==='sessions.list'){
   if(params.limit===1&&!params.search)return structuredClone(defaults);
   if(params.search==='companion-')return structuredClone(ownerPage);
   return {...structuredClone(ownerPage),sessions:ownerPage.sessions.filter(row=>row.key===params.search)};
  }
  if(method==='config.patch'){assert.equal(params.baseHash,hash);const patch=JSON.parse(params.raw);patches.push(patch);merge(config,patch);hash='hmac-sha256:'+'B'.repeat(43)+'=';return {ok:true};}
  if(method==='sessions.patch'){sessionPatches.push(params);return {ok:true,entry:{sessionId:ownerPage.sessions[0].sessionId}};}
  throw Error('unexpected '+method);
 };
 const ids=require('../dist/companion/accountIdentity');
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(url,method='GET',body,headers={})=>new Promise((resolve,reject)=>{const data=body?JSON.stringify(body):null;const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers:{'content-type':'application/json',...(data?{'content-length':Buffer.byteLength(data)}:{}),...headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,text,body:JSON.parse(text||'{}')}))});req.on('error',reject);req.end(data)});
 const owner={'x-clawmobile-owner-flow':'v1'};
 const googleAlias=ids.accountAlias('google:profile-2'),openaiAlias=ids.accountAlias('openai:owner@example.invalid');
 try{
  // 0. The captured responses really carried the defects this PR fixes.
  assert.match(JSON.stringify(fixture('companion.agent-config').response),EMAIL);
  assert.deepEqual(fixture('companion.agent-config').response.models.find(m=>m.id==='gpt-5.6-sol').thinkingLevels,['off']);
  assert.equal(typeof fixture('companion.usage').response.updatedAt,'number');
  assert.equal(fixture('companion.metadata-decision-stale').response.modelChangeAvailable,false);
  assert.equal(fixture('companion.metadata-historical')._capture.status,404);

  // 1. R6: no e-mail nor raw profile; opaque handles and neutral labels.
  const r6=await request('/v1/agent/config');assert.equal(r6.status,200);
  assert.doesNotMatch(r6.text,EMAIL);assert.doesNotMatch(r6.text,RAW_PROFILE);
  assert.equal(r6.body.model,'openai/gpt-5.6-sol@'+openaiAlias);
  assert.deepEqual(r6.body.fallbacks,['openai/gpt-5.6-luna','google/gemini-3.5-flash-lite@'+googleAlias]);
  assert.deepEqual(r6.body.accounts,[{id:openaiAlias,provider:'openai',label:'openai · compte connecté'},{id:googleAlias,provider:'google',label:'google · compte connecté'}]);
  assert.match(openaiAlias,/^acct-[a-f0-9]{12}$/);
  // 5. One thinking catalog: gpt-5.6-sol gets the Gateway session levels (R18), not « off » alone.
  const sol=r6.body.models.find(m=>m.id==='gpt-5.6-sol');
  assert.deepEqual(sol.thinkingLevels,defaults.defaults.thinkingOptions);assert.equal(sol.thinkingDefault,'low');assert.equal(sol.thinkingSource,'session_defaults');
  assert.deepEqual(r6.body.models.find(m=>m.id==='gpt-5.6-luna').thinkingLevels,['low','medium','high','xhigh','max']);
  assert.equal(r6.body.models.find(m=>m.id==='gpt-5.6-luna').thinkingSource,'model_catalog');
  const r18=await request('/v1/conversations/decision-v2-live-5a66bfd3a1/metadata');
  assert.deepEqual(sol.thinkingLevels,r18.body.thinkingLevels,'R6 and R18 publish the same levels for the same model');

  // 1b. POST: the app echoes the handles; the Gateway gets the canonical profile ids; payloadHash is computable without e-mail.
  const base={operationId:'ui-recette-thinking',provider:'openai',model:'gpt-5.6-sol',thinking:'medium',revision:hash,fallbacks:r6.body.fallbacks};
  const saved=await request('/v1/agent/config','POST',base,owner);assert.equal(saved.body.state,'completed',saved.text);
  assert.deepEqual(patches.at(-1).agents.entries.main.model.fallbacks,['openai/gpt-5.6-luna','google/gemini-3.5-flash-lite@google:profile-2']);
  assert.doesNotMatch(saved.text,EMAIL);
  assert.equal((await request('/v1/agent/config','POST',{...base,operationId:'ui-recette-unknown',revision:hash,fallbacks:['openai/gpt-5.6-luna','google/gemini-3.5-flash-lite@acct-000000000000']},owner)).status,409);
  const dropped=await request('/v1/agent/config','POST',{...base,operationId:'ui-recette-drop',revision:hash,fallbacks:['openai/gpt-5.6-luna']},owner);assert.equal(dropped.body.state,'completed');
  const confirmationApi=require('../dist/companion/confirmations').confirmations;let consumedHash=null;
  confirmationApi.status=async()=>({intent:{presentation:{title:'Repli',subtitle:'Agent',description:'Nouveau compte'},origin:{channel:'samantha',id:'owner'}}});
  confirmationApi.consume=async(id,intent)=>{assert.equal(id,'bio-fixture');consumedHash=intent.action.payloadHash;return {consumed:true};};
  const expanded={provider:'openai',model:'gpt-5.6-sol',thinking:'medium',revision:hash,fallbacks:['openai/gpt-5.6-luna','google/gemini-3.5-flash-lite@'+googleAlias]};
  assert.equal((await request('/v1/agent/config','POST',{...expanded,operationId:'ui-recette-bio-missing'},owner)).status,409,'a new @account fallback still needs the biometric confirmation');
  const bio=await request('/v1/agent/config','POST',{...expanded,operationId:'ui-recette-bio',confirmationId:'bio-fixture'},owner);assert.equal(bio.body.state,'completed',bio.text);
  // AgentConfig.desiredJson (app): {provider,model,thinking,revision,fallbacks} as sent, handles included.
  assert.equal(consumedHash,crypto.createHash('sha256').update(JSON.stringify(expanded)).digest('hex'));
  assert.deepEqual(patches.at(-1).agents.entries.main.model.fallbacks,['openai/gpt-5.6-luna','google/gemini-3.5-flash-lite@google:profile-2']);

  // 3. Composer model picker: an owner snapshot older than 60 s no longer disables it; the shared refresh starts.
  now+=61000;ownerFail=true;const configReads=counts['config.get'];
  const aging=await request('/v1/conversations/decision-v2-live-5a66bfd3a1/metadata');
  assert.equal(aging.body.modelChangeAvailable,true,aging.text);assert.ok(!aging.body.issues.includes('conversation_model_catalog_stale'));
  await new Promise(r=>setTimeout(r,20));assert.equal(counts['config.get'],configReads+1,'single shared owner refresh started');
  assert.ok(aging.body.models.includes('google/gemini-3.5-flash-lite@'+googleAlias));assert.doesNotMatch(aging.text,RAW_PROFILE);
  now+=300000;const old=await request('/v1/conversations/decision-v2-live-5a66bfd3a1/metadata');
  assert.equal(old.body.modelChangeAvailable,false);assert.ok(old.body.issues.includes('conversation_model_catalog_stale'));ownerFail=false;
  await require('../dist/companion/modelOwner').refreshModelOwner();
  // POST with a handle reaches sessions.patch with the canonical profile.
  const picked=await request('/v1/conversations/decision-v2-live-5a66bfd3a1/metadata','POST',{operationId:'ui-recette-model',model:'google/gemini-3.5-flash-lite@'+googleAlias},owner);
  assert.equal(sessionPatches.at(-1)?.model,'google/gemini-3.5-flash-lite@google:profile-2',picked.text);
  assert.equal((await request('/v1/conversations/decision-v2-live-5a66bfd3a1/metadata','POST',{operationId:'ui-recette-model-unknown',model:'google/gemini-3.5-flash-lite@acct-000000000000'},owner)).status,409);

  // 4. A listed historical conversation unknown to the Gateway: readable degraded answer, never a 404.
  const past=await request('/v1/conversations/'+historical+'/metadata');assert.equal(past.status,200,past.text);
  assert.equal(past.body.state,'degraded');assert.equal(past.body.readOnly,true);assert.equal(past.body.context,null);assert.equal(past.body.thinkingLevel,null);
  assert.equal(past.body.modelChangeAvailable,false);assert.equal(past.body.thinkingChangeAvailable,false);assert.equal(past.body.mutationAvailable,false);
  assert.deepEqual(past.body.issues,['conversation_gateway_session_unavailable']);
  assert.equal((await request('/v1/conversations/never-listed-session/metadata')).status,404,'a conversation nobody lists is still not found');

  // 7d. Previews: JSON tool results become readable text, without addresses, amounts or URLs.
  const list=await request('/v1/runs?contract=2&view=conversations&limit=20');assert.equal(list.status,200);
  const previews=Object.fromEntries(list.body.items.map(i=>[i.sessionId,i.lastResultPreview]));
  assert.equal(previews[historical],'Action terminée · provider : termux · workflow : battery · source : samantha-native-bridge');
  assert.equal(previews['decisionv2-live-read-1791497769'],'Action terminée · state : completed · operation : battery · level percent : 38');
  assert.equal(previews['decisionv2-live-fail-1791497000'],'Action en échec · error : denied');
  assert.equal(previews['decision-v2-live-5a66bfd3a1'],'Réponse texte normale');
  for(const value of Object.values(previews))assert.ok(!value.startsWith('{'));

  // 1c. Non-leak sweep: every fixture-backed read route answers without an e-mail address.
  for(const url of ['/v1/agent/config','/v1/conversations/decision-v2-live-5a66bfd3a1/metadata','/v1/conversations/'+historical+'/metadata','/v1/runs?contract=2&view=conversations&limit=20','/v1/providers'])
   assert.doesNotMatch((await request(url)).text,EMAIL,url);
  // Global guard on app state routes: whatever a producer returns, an e-mail does not leave.
  assert.equal(JSON.stringify(ids.redactAccountIdentifiers({a:'x owner@example.invalid y',['k@example.invalid']:1,n:[{m:'a@b.cd'}]})),JSON.stringify({a:'x compte masqué y','compte masqué':1,n:[{m:'compte masqué'}]}));
  for(const route of ['/agent/config','/providers','/usage','/updates','/conversations/abc/metadata','/control/engineering'])assert.ok(ids.accountGuardedRoute(route),route);
  for(const route of ['/files/content','/control/memory','/runs','/sessions/abc/turns'])assert.ok(!ids.accountGuardedRoute(route),route+' is owner content');

  // 7a. /v1/updates: the deployed commit next to the package version (SemVer build metadata accepted by tier0-native-read.py).
  const {companionBuildVersion}=require('../dist/companion/updatesControl');
  const version=companionBuildVersion();assert.match(version,/^\d+\.\d+\.\d+(\+[0-9a-f]{7})?$/);
  if(fss.existsSync(path.join(__dirname,'../../.git')))assert.match(version,/\+[0-9a-f]{7}$/,'git checkout: commit published');
  console.log('UI recette server (S24 10/10 captures): no account e-mail/profile in app responses (opaque handles, CAS/biometric hash without e-mail), one thinking catalog R6=R18, aging owner snapshot keeps the composer picker, listed historical conversation degraded not 404, readable previews, deployed commit in version passed');
 }finally{Date.now=realNow;server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
