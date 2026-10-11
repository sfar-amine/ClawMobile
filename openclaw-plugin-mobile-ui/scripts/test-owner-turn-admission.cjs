// P1 — admission native des tours owner : tests adverses (contrat playbooks 43 v2).
// Gateway simulé : CLI factice (connexion write) et SDK factice (connexion admin) qui enregistrent
// méthode, scopes et session. Formes de handshake/scopes : fixtures/s24-2026-10-11/p1 (core #172).
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http'),net=require('node:net');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'p1-admission-'));
process.env.OPENCLAW_STATE_DIR=path.join(root,'.openclaw');process.env.CLAWMOBILE_AGENT_ID='main';
delete process.env.CLAWMOBILE_RUNS_LEGACY_LOOPBACK_CONTEXT;delete process.env.CLAWMOBILE_INTENT_WAIT_FOR_FINAL;
os.homedir=()=>root;{const work=path.join(root,'.openclaw/workspace');fs.mkdirSync(path.join(work,'context'),{recursive:true});
 for(const [f,v] of [['SOUL.md','IDENTITY'],['USER.md','USER'],['context/HYBRID_CONTEXT.md','HYBRID'],['context/OPERATING_RULES.md','RULES\n## Règles spécialisées\nOK\n']])fs.writeFileSync(path.join(work,f),v);}
const state=path.join(process.env.OPENCLAW_STATE_DIR,'clawmobile-companion');fs.mkdirSync(state,{recursive:true});
fs.writeFileSync(path.join(state,'runs.json'),JSON.stringify({version:1,runs:[],archivedSessionIds:[],ownerConfirmations:[],paymentRequests:[],runDeletions:[]}));
// Clé owner-confirmation (biométrique dans l'app) épinglée par installation contrôlée, comme sur le S24.
const biometric=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
fs.writeFileSync(path.join(state,'owner-confirmation-public.pem'),biometric.publicKey.export({type:'spki',format:'pem'}));
// Pré-routeur capability : toujours « miss », le tour part vers le Gateway.
// « ambigu » ouvre une CLARIFY ; une résolution renvoie un texte dérivé de la clarification (marqueur ATTACKER_DERIVED).
const helper=path.join(root,'fast-path.py'),helperLog=path.join(root,'fast-path.log');
fs.writeFileSync(helper,['import json,sys','m=sys.argv[-1]','mode="resolve" if "--resolve-clarification" in sys.argv else "check"',
 'caller=sys.argv[sys.argv.index("--caller")+1]',
 'open('+JSON.stringify(helperLog)+',"a").write(json.dumps({"mode":mode,"message":m,"caller":caller,"executing":"--execute-decision" in sys.argv})+"\\n")',
 'd=lambda k,i:{"version":2,"type":k,"decisionId":i,"requestId":i,"textHash":"x","capabilityRevision":"rev","contractHash":"hash"}',
 'if "p1-write" in m:',
 ' if "revoke-resolution" in m and "--check" in sys.argv:',
 '  import time,os',
 '  for _ in range(300):',
 '   if os.path.exists('+JSON.stringify(path.join(root,'resolution-release'))+'): break',
 '   time.sleep(.01)',
 ' status="eligible" if "--check" in sys.argv else "hit" if caller=="owner" else "known_error"',
 ' print(json.dumps({"status":status,"text":"synthetic result; no real effect","decision":{**d("EXECUTE","synthetic-write"),"risk":"write","caller":caller,"capability":"synthetic.offline.write"}}))',
 'elif mode=="resolve": print(json.dumps({"status":"miss","resolution":{"text":"ATTACKER_DERIVED "+m}}))',
 'elif "ambigu" in m: print(json.dumps({"status":"clarification","text":"Tu veux consulter ou agir ?","model_bypassed":True,"decision":{**d("CLARIFY","c-"+m[-8:]),"clarification":{"question":"Tu veux consulter ou agir ?","choices":[{"intent":"read","label":"consulter"},{"intent":"act","label":"agir"}]}}}))',
 'else: print(json.dumps({"status":"miss","reason":"fixture"}))',''].join('\n'));process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER=helper;
// Connexion write (CLI canonique) factice.
const cliLog=path.join(root,'cli.jsonl'),cli=path.join(root,'openclaw-cli.py');
fs.writeFileSync(cli,'#!/usr/bin/env python3\nimport json,sys\np=json.loads(sys.argv[sys.argv.index("--params")+1])\nopen('+JSON.stringify(cliLog)+',"a").write(json.dumps({"transport":"cli_write","method":sys.argv[3] if sys.argv[3]!="--expect-final" else sys.argv[4],"sessionKey":p["sessionKey"],"id":p["idempotencyKey"],"extra":"extraSystemPrompt" in p})+"\\n")\nprint(json.dumps({"runId":p["idempotencyKey"],"status":"accepted"}))\n');
fs.chmodSync(cli,0o700);process.env.CLAWMOBILE_OPENCLAW_BIN=cli;
const sdkCalls=[];let sdkMode='ok';
// Clock captured by the canonical admission instance; only expiry test changes the offset.
const nativeClock=Date.now;let admissionClockOffset=0;Date.now=()=>nativeClock()+admissionClockOffset;
const gatewayTransport=require('../dist/companion/ownerTurnGateway');
const {fakePublicSdk}=require('./fixtures/owner-turn-public-sdk.cjs');
gatewayTransport.setOwnerTurnSdkLoader(async()=>{
 if(sdkMode==='missing')throw Object.assign(new Error('x'),{code:'owner_transport_unavailable'});
 return fakePublicSdk(async(method,opts,params,extra)=>{
  sdkCalls.push({transport:'admin',method,scopes:extra.scopes,sessionKey:params.sessionKey,id:params.idempotencyKey,progress:extra.progress,opts,extraKeys:Object.keys(extra).sort(),message:params.message,signal:extra.signal});
  if(sdkMode==='fail')throw Object.assign(new Error('boom'),{gatewayCode:'UNAVAILABLE'});
  return {runId:params.idempotencyKey,status:'accepted'};
 });
});
const {turnAdmission,createTurnAdmission,admissionMessage,enrollmentMessage,enrollmentPresentation,recentAdmissionRefusals,ADMISSION_WINDOW_MS,NONCE_CAPACITY,sha256Hex}=require('../dist/companion/ownerTurnAdmission');
const lastReason=()=>{const r=recentAdmissionRefusals();return r.length?r[r.length-1].reason:undefined;};
const GENERIC={owner:false,reason:'not_admitted'};
const {confirmations}=require('../dist/companion/confirmations');
const {route}=require('../dist/companion/server');

const admissionKey=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const spki=k=>k.publicKey.export({type:'spki',format:'der'});
const keyIdOf=k=>sha256Hex(spki(k));
const KEY=keyIdOf(admissionKey);
const nonce=()=>crypto.randomBytes(16).toString('hex');
function proof({method='POST',pathName='/v1/runs',body,clientRunId,sessionId,ts=Date.now(),n=nonce(),key=admissionKey,keyId=keyIdOf(key)}){
 const message=admissionMessage({method,path:pathName,bodyHash:sha256Hex(Buffer.from(body)),clientRunId,sessionId,timestamp:String(ts),nonce:n,keyId});
 return {'x-samantha-admission':'v1','x-samantha-admission-key':keyId,'x-samantha-admission-ts':String(ts),'x-samantha-admission-nonce':n,
  'x-samantha-admission-signature':crypto.sign('sha256',Buffer.from(message),key.privateKey).toString('base64')};
}
let server,port;
const request=(method,url,body,headers={})=>new Promise((resolve,reject)=>{
 const data=body===undefined?undefined:(typeof body==='string'?body:JSON.stringify(body));
 const req=http.request({host:'127.0.0.1',port,path:url,method,headers:{...(data!==undefined?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),...headers}},res=>{let t='';res.on('data',x=>t+=x);res.on('end',()=>{let b;try{b=JSON.parse(t)}catch{b=t}resolve({status:res.statusCode,body:b})});});
 req.on('error',reject);req.end(data);
});
const owner={'x-clawmobile-owner-flow':'v1'};
async function biometricApprove(type,reference,payloadHash,origin={channel:'samantha',id:'turn-admission'},signer=biometric,presentation=enrollmentPresentation(reference)){
 const prepared=await request('POST','/v1/confirmations',{requestKey:crypto.randomUUID(),action:{type,reference,payloadHash},presentation,origin},owner);
 assert.equal(prepared.status,200);const id=prepared.body.requestId;
 if(!signer)return id;
 const challenge=(await request('GET',`/v1/confirmations/${id}/challenge`,undefined,owner)).body;
 const signed=await request('POST',`/v1/confirmations/${id}/owner-confirmation`,{keyId:challenge.keyId,nonce:challenge.nonce,bindingHash:challenge.bindingHash,signature:crypto.sign('sha256',Buffer.from(challenge.challenge),signer.privateKey).toString('base64')},owner);
 return signer===biometric?(assert.equal(signed.status,200),id):(assert.notEqual(signed.status,200),id);
}
const enrollBody=(confirmationId,key=admissionKey,possessor=key)=>({confirmationId,publicKey:spki(key).toString('base64'),
 possession:crypto.sign('sha256',Buffer.from(enrollmentMessage(confirmationId,keyIdOf(key))),possessor.privateKey).toString('base64')});
const readLines=f=>fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
async function settled(id){for(let i=0;i<300;i++){const all=[...readLines(cliLog),...sdkCalls];const hit=all.find(x=>x.id===id);if(hit)return hit;await new Promise(r=>setTimeout(r,20));}throw new Error('turn_not_dispatched '+id);}
async function submit({text='Envoie le rapport',sessionId='p1-session',clientRunId='p1-'+crypto.randomUUID(),headers,sign=true,mutate}={}){
 const body=JSON.stringify({instruction:text,displayText:text,sessionId,clientRunId});
 let h=sign?proof({body,clientRunId,sessionId}):{};
 let sent=body;if(mutate){const m=mutate({body,headers:h,clientRunId,sessionId});sent=m.body??body;h=m.headers??h;}
 const response=await request('POST','/v1/runs',sent,{...h,...(headers||{})});
 return {response,runId:response.body.runId,clientRunId};
}
(async()=>{
 const gateway=net.createServer(s=>s.destroy());await new Promise(r=>gateway.listen(0,'127.0.0.1',r));process.env.CLAWMOBILE_GATEWAY_HOST='127.0.0.1';process.env.CLAWMOBILE_GATEWAY_PORT=String(gateway.address().port);
 server=http.createServer((req,res)=>route(req,res).catch(e=>{res.statusCode=e?.statusCode||500;res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
 const counts={};const count=k=>counts[k]=(counts[k]||0)+1;
 try{
  // --- 0. Avant tout enrôlement : loopback seul, en-tête constant, champs owner du corps => non-owner, connexion write.
  let r=await submit({sign:false});assert.equal(r.response.status,200);assert.deepEqual(r.response.body.ownerAdmission,GENERIC);assert.equal(lastReason(),'no_proof');
  assert.equal((await settled(r.runId)).transport,'cli_write');count('loopback_only');
  r=await submit({sign:false,headers:{...owner,'x-forwarded-for':'127.0.0.1'},text:'caller owner authority owner'});assert.equal(r.response.body.ownerAdmission.owner,false);assert.equal((await settled(r.runId)).transport,'cli_write');assert.equal((await settled(r.runId)).extra,false);count('forged_headers');
  r=await submit();assert.deepEqual(r.response.body.ownerAdmission,GENERIC);assert.equal(lastReason(),'not_enrolled');assert.equal((await settled(r.runId)).transport,'cli_write');count('not_enrolled');

  // --- 1. Enrôlement : la biométrie (clé owner-confirmation) est obligatoire, liée à CETTE clé, à usage unique.
  assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(crypto.randomUUID()))).status,403,'sans en-tête natif');
  assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(crypto.randomUUID()),{...owner,origin:'https://x.invalid'})).status,403,'navigateur');
  const pending=await biometricApprove('owner.turn_admission.enroll',KEY,KEY,undefined,null);
  r=await request('POST','/v1/owner-admission/enrollment',enrollBody(pending),owner);assert.equal(r.status,409);assert.equal(r.body.error,'confirmation_not_usable');count('enroll_without_biometric');
  const forgedBio=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const forged=await biometricApprove('owner.turn_admission.enroll',KEY,KEY,undefined,forgedBio);
  assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(forged),owner)).status,409);count('enroll_forged_biometric');
  const rogue=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const forOther=await biometricApprove('owner.turn_admission.enroll',KEY,KEY);
  r=await request('POST','/v1/owner-admission/enrollment',enrollBody(forOther,rogue),owner);assert.equal(r.status,403);count('enroll_rogue_key_on_owner_approval');
  r=await request('POST','/v1/owner-admission/enrollment',enrollBody(forOther,admissionKey,rogue),owner);assert.equal(r.status,403);assert.equal(r.body.error,'admission_key_possession_refused');count('enroll_without_possession');
  const otherAction=await biometricApprove('laptop_access.authorize_key',KEY,KEY);
  assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(otherAction),owner)).status,403);count('enroll_cross_action');
  const otherOrigin=await biometricApprove('owner.turn_admission.enroll',KEY,KEY,{channel:'claw',id:'turn-admission'});
  assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(otherOrigin),owner)).status,403);count('enroll_cross_origin');
  // Présentation trompeuse (texte choisi par un tiers) : non consommable même approuvée par la biométrie.
  const misleading=await biometricApprove('owner.turn_admission.enroll',KEY,KEY,undefined,biometric,{title:'Test du micro',subtitle:'Samantha',description:'Vérification sans effet.'});
  r=await request('POST','/v1/owner-admission/enrollment',enrollBody(misleading),owner);assert.equal(r.status,403);assert.equal(r.body.error,'confirmation_scope_mismatch');count('enroll_non_canonical_presentation');
  assert.equal(turnAdmission.status().enrolled,false);
  r=await request('POST','/v1/owner-admission/enrollment',enrollBody(forOther),owner);assert.equal(r.status,200);assert.equal(r.body.state,'enrolled');assert.equal(r.body.keyId,KEY);
  assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(forOther),owner)).status,409,'confirmation consommée');count('enroll_replay');
  const st=await request('GET','/v1/owner-admission');assert.equal(st.status,200);assert.equal(st.body.enrolled,true);assert.ok(!('keyId' in st.body)&&!('enrolledAt' in st.body)&&!JSON.stringify(st.body).includes(KEY.slice(0,12)),'aucun keyId sans le présenter');
  assert.equal((await request('GET','/v1/owner-admission',undefined,{'x-samantha-admission-key':KEY})).body.keyMatches,true);
  assert.equal((await request('GET','/v1/owner-admission',undefined,{'x-samantha-admission-key':keyIdOf(rogue)})).body.keyMatches,false);count('status_without_key_id');
  assert.equal((fs.statSync(path.join(state,'owner-turn-admission.json')).mode&0o777),0o600);

  // --- 2. Preuve valide => owner, sur la connexion admin uniquement (scopes admin/write, méthode agent seule).
  r=await submit();assert.equal(r.response.status,200);assert.deepEqual(r.response.body.ownerAdmission,{owner:true});
  let hit=await settled(r.runId);assert.equal(hit.transport,'admin');assert.equal(hit.method,'agent');assert.deepEqual(hit.scopes,['operator.admin','operator.write']);assert.equal(hit.progress,false);
  assert.equal(readLines(cliLog).filter(x=>x.id===r.runId).length,0);count('valid_owner_admin_only');
  // Forme d'appel figée contre la signature installée (fixture S24 claw_exec r03 : callGatewayFromCli(method, opts, params, extra)).
  {const sig=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/p1/callgatewayfromcli-signature.json'),'utf8'));
   assert.match(sig.signature,/^callGatewayFromCli\(method, opts, params, extra\)/);
   for(const line of ['scopes: extra?.scopes,','signal: extra?.signal,','expectFinal: extra?.expectFinal ?? Boolean(opts.expectFinal),','clientName: extra?.clientName ?? GATEWAY_CLIENT_NAMES.CLI,'])assert.ok(sig.runtime_excerpt.includes(line),line);
   assert.ok(sig.call_excerpt.includes('if (Array.isArray(opts.scopes)) return await callGatewayWithScopes(opts, opts.scopes);'));
   assert.ok(hit.signal instanceof AbortSignal);assert.ok(hit.extraKeys.includes('clientOptions'));
   assert.deepEqual(hit.opts,{json:true,timeout:'15000',expectFinal:false});count('sdk_signature_contract');}
  {let run;for(let i=0;i<50&&!(run=(await request('GET','/v1/runs/'+r.runId)).body).ownerTransport;i++)await new Promise(x=>setTimeout(x,20));
   assert.equal(run.ownerTransport,'admin_admitted');assert.equal(run.ownerAdmitted,true);
   const listed=(await request('GET','/v1/runs?limit=50')).body.runs.find(x=>x.runId===r.runId);assert.equal(listed.ownerTransport,'admin_admitted');count('run_owner_transport');}

  // --- 3. Refus adverses : chacun => non-owner, connexion write, jamais l'admin.
  const adverse=async(name,options,reason)=>{const before=sdkCalls.length;const x=await submit(options);if(x.response.status===403&&!x.response.body.ownerAdmission){assert.equal(x.runId,undefined);assert.equal(sdkCalls.length,before,name);count(name);return;}assert.equal(x.response.body.ownerAdmission.owner,false,name);assert.deepEqual(x.response.body.ownerAdmission,GENERIC,name);if(reason)assert.equal(lastReason(),reason,name);
   if(x.runId){assert.equal((await settled(x.runId)).transport,'cli_write',name);}assert.equal(sdkCalls.length,before,name);count(name);};
  await adverse('no_proof',{sign:false},'no_proof');
  await adverse('bad_signature',{mutate:({headers})=>({headers:{...headers,'x-samantha-admission-signature':crypto.sign('sha256',Buffer.from('autre'),admissionKey.privateKey).toString('base64')}})},'bad_signature');
  await adverse('foreign_key_signature',{mutate:({body,clientRunId,sessionId})=>({headers:proof({body,clientRunId,sessionId,key:rogue,keyId:KEY})})},'bad_signature');
  await adverse('unknown_key',{mutate:({body,clientRunId,sessionId})=>({headers:proof({body,clientRunId,sessionId,key:rogue})})},'unknown_key');
  await adverse('stale_timestamp_past',{mutate:({body,clientRunId,sessionId})=>({headers:proof({body,clientRunId,sessionId,ts:Date.now()-ADMISSION_WINDOW_MS-1000})})},'stale_timestamp');
  await adverse('stale_timestamp_future',{mutate:({body,clientRunId,sessionId})=>({headers:proof({body,clientRunId,sessionId,ts:Date.now()+ADMISSION_WINDOW_MS+1000})})},'stale_timestamp');
  await adverse('body_tampered',{mutate:({body})=>({body:body.replace('Envoie le rapport','Supprime tout   ')})},'bad_signature');
  await adverse('other_run_id',{mutate:({body,sessionId})=>({headers:proof({body,clientRunId:'p1-other-run-id',sessionId})})},'bad_signature');
  await adverse('other_session',{mutate:({body,clientRunId})=>({headers:proof({body,clientRunId,sessionId:'autre-session'})})},'bad_signature');
  await adverse('other_path',{mutate:({body,clientRunId,sessionId})=>({headers:proof({body,clientRunId,sessionId,pathName:'/v1/skills/learn'})})},'bad_signature');
  await adverse('other_method',{mutate:({body,clientRunId,sessionId})=>({headers:proof({body,clientRunId,sessionId,method:'DELETE'})})},'bad_signature');
  await adverse('malformed_version',{mutate:({headers})=>({headers:{...headers,'x-samantha-admission':'v0'}})},'malformed_proof');
  await adverse('partial_headers',{mutate:({headers})=>{const h={...headers};delete h['x-samantha-admission-nonce'];return {headers:h};}},'malformed_proof');
  await adverse('missing_client_run_id',{mutate:({body,sessionId})=>{const b=JSON.stringify({...JSON.parse(body),clientRunId:undefined});return {body:b,headers:proof({body:b,clientRunId:'',sessionId})};}});
  await adverse('browser_origin_with_valid_proof',{headers:{origin:'https://x.invalid'}},'no_proof');
  // Rejeu exact du même tour : nonce refusé, et le clientRunId déjà connu ne crée pas de second tour.
  {const body=JSON.stringify({instruction:'Rejoue',displayText:'Rejoue',sessionId:'p1-session',clientRunId:'p1-replay-0001'});const h=proof({body,clientRunId:'p1-replay-0001',sessionId:'p1-session'});
   const a=await request('POST','/v1/runs',body,h);assert.equal(a.body.ownerAdmission.owner,true);await settled(a.body.runId);
   const b=await request('POST','/v1/runs',body,h);assert.deepEqual(b.body.ownerAdmission,GENERIC);assert.equal(lastReason(),'replayed_nonce');assert.equal(b.body.runId,a.body.runId);assert.equal(b.body.duplicate??true,true);
   assert.equal([...sdkCalls,...readLines(cliLog)].filter(x=>x.id===a.body.runId).length,1);count('replayed_nonce');}
  // Nonce identique sur un autre tour signé : refusé aussi.
  {const n=nonce();const b1=JSON.stringify({instruction:'A',sessionId:'s',clientRunId:'p1-nonce-aaaa'}),b2=JSON.stringify({instruction:'B',sessionId:'s',clientRunId:'p1-nonce-bbbb'});
   assert.equal((await request('POST','/v1/runs',b1,proof({body:b1,clientRunId:'p1-nonce-aaaa',sessionId:'s',n}))).body.ownerAdmission.owner,true);
   assert.deepEqual((await request('POST','/v1/runs',b2,proof({body:b2,clientRunId:'p1-nonce-bbbb',sessionId:'s',n}))).body.ownerAdmission,GENERIC);assert.equal(lastReason(),'replayed_nonce');count('nonce_reuse_other_turn');}

  // --- 4. Unitaires : cache borné, fermé quand plein ; requêtes non signées ne le remplissent pas ; ticket opaque.
  {let clock=1_800_000_000_000;const dir=path.join(root,'unit');fs.mkdirSync(dir);fs.copyFileSync(path.join(state,'owner-turn-admission.json'),path.join(dir,'owner-turn-admission.json'));
   const unit=createTurnAdmission({stateDir:()=>dir,clock:()=>clock});
   const req=(i,n=nonce(),sign=true)=>{const body=Buffer.from('{"i":'+i+'}');const h=proof({body:body.toString(),clientRunId:'unit-run-'+i,sessionId:'u',ts:clock,n});if(!sign)h['x-samantha-admission-signature']=crypto.sign('sha256',Buffer.from('x'),rogue.privateKey).toString('base64');return {method:'POST',path:'/v1/runs',headers:h,rawBody:body,clientRunId:'unit-run-'+i,sessionId:'u'};};
   for(let i=0;i<5000;i++)assert.equal(unit.verifyRequest(req(i,undefined,false)).reason,'bad_signature');assert.equal(unit.nonceCount(),0);count('unsigned_flood_no_cache_growth');
   for(let i=0;i<NONCE_CAPACITY;i++)assert.equal(unit.verifyRequest(req(i)).admitted,true);
   assert.equal(unit.verifyRequest(req(99999)).reason,'nonce_cache_full');count('nonce_cache_full_fail_closed');
   clock+=70_000;const fresh=unit.verifyRequest(req(100000));assert.equal(fresh.admitted,true);assert.equal(unit.nonceCount(),1);count('nonce_ttl_purge');
   assert.equal(unit.isCurrent(fresh.ticket,{clientRunId:'unit-run-100000',sessionId:'u'}),true);
   assert.equal(unit.isCurrent({...fresh.ticket},{clientRunId:'unit-run-100000',sessionId:'u'}),false,'copie sérialisée');
   assert.equal(turnAdmission.isCurrent(fresh.ticket,{clientRunId:'unit-run-100000',sessionId:'u'}),false,'autre instance');
   assert.equal(unit.isCurrent(fresh.ticket,{clientRunId:'unit-run-other',sessionId:'u'}),false);assert.equal(unit.isCurrent(fresh.ticket,{clientRunId:'unit-run-100000',sessionId:'v'}),false);
   clock+=61_000;assert.equal(unit.isCurrent(fresh.ticket,{clientRunId:'unit-run-100000',sessionId:'u'}),false,'ticket expiré');count('ticket_binding');
   const dup={...req(5)};dup.headers['x-samantha-admission-nonce']=[dup.headers['x-samantha-admission-nonce'],nonce()];assert.equal(unit.verifyRequest(dup).reason,'malformed_proof');count('duplicated_header');
   fs.writeFileSync(path.join(dir,'owner-turn-admission.json'),'{"version":1,"keyId":"'+'a'.repeat(64)+'"}');assert.equal(unit.verifyRequest(req(7)).reason,'enrollment_unreadable');count('corrupt_enrollment_fail_closed');
   fs.copyFileSync(path.join(state,'owner-turn-admission.json'),path.join(dir,'owner-turn-admission.json'));fs.chmodSync(path.join(dir,'owner-turn-admission.json'),0o666);
   assert.equal(unit.verifyRequest(req(8)).reason,'enrollment_unreadable','fichier modifiable par autrui');
   fs.chmodSync(path.join(dir,'owner-turn-admission.json'),0o644);assert.equal(unit.verifyRequest(req(9)).admitted,true);
   assert.equal(fs.statSync(path.join(dir,'owner-turn-admission.json')).mode&0o777,0o600,'resserré à 0600');count('enrollment_permissions');}

  // --- 5. Transport admin indisponible AVANT envoi : le tour reste non-owner (CLI) ; échec APRÈS envoi : aucun rejeu.
  gatewayTransport.setOwnerTurnSdkLoader(async()=>{throw Object.assign(new Error('x'),{code:'owner_transport_unavailable'})});
  r=await submit();assert.equal(r.response.body.ownerAdmission.owner,true);await new Promise(x=>setTimeout(x,150));assert.equal(readLines(cliLog).filter(x=>x.id===r.runId).length,0);assert.equal((await request('GET','/v1/runs/'+r.runId)).body.state,'failed');count('admin_unavailable_fail_closed');
  gatewayTransport.setOwnerTurnSdkLoader(async()=>fakePublicSdk(async(method,o,params,extra)=>{sdkCalls.push({transport:'admin',method,scopes:extra.scopes,id:params.idempotencyKey});throw new Error('after dispatch');}));
  r=await submit();await settled(r.runId);await new Promise(x=>setTimeout(x,200));
  assert.equal(readLines(cliLog).filter(x=>x.id===r.runId).length,0,'pas de repli après envoi');
  const failed=(await request('GET','/v1/runs/'+r.runId)).body;assert.equal(failed.state,'failed');count('no_replay_after_dispatch');
  gatewayTransport.setOwnerTurnSdkLoader(async()=>fakePublicSdk(async(method,opts,params,extra)=>{sdkCalls.push({transport:'admin',method,scopes:extra.scopes,sessionKey:params.sessionKey,id:params.idempotencyKey,message:params.message});await new Promise(x=>setTimeout(x,30));return {runId:params.idempotencyKey,status:'accepted'};}));

  // --- 6. Concurrence : tours admis et non admis simultanés, sans croisement de connexion.
  {const jobs=[];for(let i=0;i<8;i++){jobs.push(submit({sessionId:'own-'+i}).then(x=>({x,owner:true})));jobs.push(submit({sessionId:'pub-'+i,sign:false}).then(x=>({x,owner:false})));}
   const done=await Promise.all(jobs);
   for(const {x,owner:o} of done){const t=await settled(x.runId);assert.equal(x.response.body.ownerAdmission.owner,o);assert.equal(t.transport,o?'admin':'cli_write');assert.ok(t.sessionKey.includes(o?'own-':'pub-'));}
   count('concurrent_isolation');}

  // --- 6b. Édition-relecture (#181) : replayOf réservé à l'admission signée.
  {const src=await submit({sessionId:'replay-src'});await settled(src.runId);await new Promise(x=>setTimeout(x,100));await require('../dist/companion/runs').settleSubmittedRun(src.runId,'done','fait');
   const body=JSON.stringify({instruction:'Édité',displayText:'Édité',sessionId:'replay-dst-1',clientRunId:'p1-replay-noproof',replayOf:{sessionId:'replay-src',runId:src.runId}});
   let x=await request('POST','/v1/runs',body,{});assert.equal(x.status,403);assert.equal(x.body.message,'owner_required');
   x=await request('POST','/v1/runs',body,{...owner,'x-clawmobile-owner-flow':'v1'});assert.equal(x.status,403,'en-tête constant');
   process.env.CLAWMOBILE_RUNS_LEGACY_LOOPBACK_CONTEXT='1';x=await request('POST','/v1/runs',body,{});assert.equal(x.status,403,'drapeau legacy');delete process.env.CLAWMOBILE_RUNS_LEGACY_LOOPBACK_CONTEXT;
   const signed=JSON.stringify({instruction:'Édité',displayText:'Édité',sessionId:'replay-dst-2',clientRunId:'p1-replay-proof',replayOf:{sessionId:'replay-src',runId:src.runId}});
   x=await request('POST','/v1/runs',signed,proof({body:signed,clientRunId:'p1-replay-proof',sessionId:'replay-dst-2'}));assert.equal(x.status,200);assert.deepEqual(x.body.ownerAdmission,{owner:true});
   assert.equal((await settled(x.body.runId)).transport,'admin');count('replay_without_proof_403');count('replay_with_proof_admin');}
  // --- 6c. CLARIFY : un tour admis ne reprend jamais une clarification ouverte par un tour non admis (confused deputy).
  {const helperCalls=()=>readLines(helperLog);
   const rogue1=await submit({sessionId:'clarify-1',sign:false,text:'ambigu rogue-01'});assert.equal(rogue1.response.body.state,'done');
   const before=helperCalls().length;
   const own=await submit({sessionId:'clarify-1',text:'oui agis'});assert.deepEqual(own.response.body.ownerAdmission,{owner:true});
   const t=await settled(own.runId);assert.equal(t.transport,'admin');assert.ok(!t.message.includes('ATTACKER_DERIVED')&&t.message.endsWith('oui agis'));
   assert.ok(!helperCalls().slice(before).some(c=>c.mode==='resolve'),'aucune résolution de la clarification tierce');
   assert.equal((await request('GET','/v1/runs/'+rogue1.runId)).body.ownerAdmitted,undefined);
   const parent=JSON.parse(fs.readFileSync(path.join(state,'runs.json'))).runs.find(x=>x.runId===rogue1.runId);assert.equal(parent.clarificationState,'abandoned');
   assert.equal((await request('GET','/v1/runs/'+own.runId)).body.ownerAdmitted,true);count('clarify_admitted_ignores_unadmitted');
   // Inverse : une clarification ouverte par Amine n'est ni reprise ni annulée par un tour non admis.
   const own2=await submit({sessionId:'clarify-2',text:'ambigu owner-02'});assert.equal(own2.response.body.state,'done');
   const b2=helperCalls().length;const rogue2=await submit({sessionId:'clarify-2',sign:false,text:'agir'});
   assert.ok(!helperCalls().slice(b2).some(c=>c.mode==='resolve'));assert.equal((await settled(rogue2.runId)).transport,'cli_write');
   assert.equal(JSON.parse(fs.readFileSync(path.join(state,'runs.json'))).runs.find(x=>x.runId===own2.runId).clarificationState,'pending');
   // Propriétaire existant : seule la clarification du dernier run de la session est reprise ; le tour tiers la masque (refus fermé, aucun texte tiers).
   const b3=helperCalls().length;const own3=await submit({sessionId:'clarify-2',text:'agir'});assert.ok(!helperCalls().slice(b3).some(c=>c.mode==='resolve'));
   await settled(own3.runId);count('clarify_unadmitted_cannot_touch_admitted');}

  // Voice option A: the marker is signed data, not admission or an arbitrary agent selector.
  {const client=require('../dist/companion/openclawAgentClient');
   for(const extra of [{}, {agentId:'attacker'}, {voiceDelegation:'true'}, {replayOf:{sessionId:'x',runId:'y'}}, {attachments:[]}]) {
    const cid='voice-negative-'+crypto.randomUUID(),body=JSON.stringify({instruction:'Souviens-toi du rendez-vous',sessionId:'voice-parity',clientRunId:cid,voiceDelegation:true,...extra});
    const signed=Object.keys(extra).length?proof({body,clientRunId:cid,sessionId:'voice-parity'}):{};
    const refusal=await request('POST','/v1/runs',body,signed);assert.equal(refusal.status,Object.keys(extra).length?400:403);assert.equal(refusal.body.submissionState,'not_submitted');count('voice_closed_delegation');
   }
   const cid='voice-native-'+crypto.randomUUID(),body=JSON.stringify({instruction:'Souviens-toi du rendez-vous',sessionId:'voice-parity',clientRunId:cid,voiceDelegation:true});
   const headers=proof({body,clientRunId:cid,sessionId:'voice-parity'}),admitted=turnAdmission.verifyRequest({method:'POST',path:'/v1/runs',headers,rawBody:Buffer.from(body),clientRunId:cid,sessionId:'voice-parity'});assert(admitted.admitted);
   for(const opts of [{},{admission:admitted.ticket,clientRunId:cid,voiceDelegation:true},{admission:admitted.ticket,clientRunId:'other-client',voiceDelegation:true}]) {
    await assert.rejects(()=>client.submitToOpenClawAgent('Mémoire','voice-refused-'+crypto.randomUUID(),'other-session',{voiceDelegation:true,...opts}),/voice_owner_admission_required/);count('voice_ticket_bound');
   }
   let delegated;gatewayTransport.setOwnerTurnSdkLoader(async()=>fakePublicSdk(async(method,opts,params)=>{delegated=params;return {runId:params.idempotencyKey,status:'accepted'};}));
   process.env.CLAWMOBILE_AGENT_ID='other-agent';const result=await client.submitToOpenClawAgent('Souviens-toi du rendez-vous','voice-main-run','voice-parity',{admission:admitted.ticket,clientRunId:cid,voiceDelegation:true});process.env.CLAWMOBILE_AGENT_ID='main';
   assert.equal(result.ownerTransport,'admin_admitted');assert.equal(delegated.agentId,'main');assert.equal(delegated.sessionKey,'companion-chat-voice-parity');assert(delegated.message.endsWith('Souviens-toi du rendez-vous'));count('voice_main_same_conversation');
   gatewayTransport.setOwnerTurnSdkLoader(async()=>{throw Object.assign(new Error('missing'),{code:'owner_transport_unavailable'});});
   await assert.rejects(()=>client.submitToOpenClawAgent('Mémoire','voice-no-fallback','voice-parity',{admission:admitted.ticket,clientRunId:cid,voiceDelegation:true}));assert.equal(readLines(cliLog).filter(x=>x.id==='voice-no-fallback').length,0);count('voice_no_write_fallback');
   await assert.rejects(()=>client.submitToOpenClawAgent('Mémoire','voice-wrong-client','voice-parity',{admission:admitted.ticket,clientRunId:'other-client',voiceDelegation:true}),/voice_owner_admission_required/);count('voice_wrong_client_same_session');
   let began,release;const started=new Promise(r=>began=r),gate=new Promise(r=>release=r);let sent=0;
   gatewayTransport.setOwnerTurnSdkLoader(async()=>{began();await gate;return fakePublicSdk(async()=>{sent++;return {};})});
   const loading=client.submitToOpenClawAgent('Mémoire','voice-revoked-loading','voice-parity',{admission:admitted.ticket,clientRunId:cid,voiceDelegation:true});
   const refused=assert.rejects(loading,/owner_turn_admission_expired/);await started;turnAdmission.revoke();release();await refused;
   assert.equal(sent,0);assert.equal(readLines(cliLog).filter(x=>x.id==='voice-revoked-loading').length,0);count('voice_revoked_loading_no_fallback');
   const enroll=await biometricApprove('owner.turn_admission.enroll',KEY,KEY);assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(enroll),owner)).status,200);
  }
  // SDK loading is an await before dispatch: revocation during it must never reach admin.
  {const clientRunId='p1-sdk-race-0001',sessionId='sdk-race',rawBody=Buffer.from('{}');
   const ticket=turnAdmission.verifyRequest({method:'POST',path:'/v1/runs',headers:proof({body:'{}',clientRunId,sessionId}),rawBody,clientRunId,sessionId});assert.equal(ticket.admitted,true);
   let entered,release;const loadingStarted=new Promise(r=>entered=r),loadingGate=new Promise(r=>release=r);
   const before=sdkCalls.length;
   gatewayTransport.setOwnerTurnSdkLoader(async()=>{entered();await loadingGate;return fakePublicSdk(async(method,opts,params,extra)=>{sdkCalls.push({transport:'admin',id:params.idempotencyKey});return {runId:params.idempotencyKey,status:'accepted'};});});
   const pending=require('../dist/companion/openclawAgentClient').submitToOpenClawAgent('tour','p1-sdk-race-run',sessionId,{admission:ticket.ticket,clientRunId});
   await loadingStarted;turnAdmission.revoke();release();
   await assert.rejects(pending,e=>e.code==='owner_turn_admission_expired');
   assert.equal(sdkCalls.length,before,'revoked while SDK loading: no admin request');
   assert.equal(readLines(cliLog).filter(r=>r.id==='p1-sdk-race-run').length,0);
   const again=await biometricApprove('owner.turn_admission.enroll',KEY,KEY);assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(again),owner)).status,200);
   count('revocation_during_sdk_loading');}

  // Public client bootstrap/HELLO boundary. Synthetic client, no real connection/account.
  {const reEnroll=async()=>{const c=await biometricApprove('owner.turn_admission.enroll',KEY,KEY);assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(c),owner)).status,200);};
   let seq=0;
   const admitted=()=>{const clientRunId='public-sdk-'+(++seq),sessionId='public-sdk',body='{}';
    const ticket=turnAdmission.verifyRequest({method:'POST',path:'/v1/runs',headers:proof({body,clientRunId,sessionId}),rawBody:Buffer.from(body),clientRunId,sessionId});assert.equal(ticket.admitted,true);
    return {params:{message:'synthetic only',sessionKey:'agent:main:companion-chat-public-sdk',idempotencyKey:'public-'+seq},options:{timeoutMs:1000,admission:ticket.ticket,binding:{clientRunId,sessionId}}};};
   async function rejectBefore(hooks, code){let calls=0;gatewayTransport.setOwnerTurnSdkLoader(async()=>fakePublicSdk(()=>{calls++;return {}},hooks));const x=admitted();await assert.rejects(gatewayTransport.submitOwnerTurn(x.params,x.options),e=>e.code===code&&e.requestSent===false);assert.equal(calls,0);}
   await rejectBefore({config:{gateway:{mode:'remote',port:1234,auth:{mode:'token',token:'fake'}}}},'owner_transport_target_unsupported');count('public_remote_closed');
   await rejectBefore({config:{gateway:{mode:'local',tls:{enabled:true},port:1234,auth:{mode:'token',token:'fake'}}}},'owner_transport_target_unsupported');count('public_tls_closed');
   process.env.OPENCLAW_GATEWAY_URL='ws://127.0.0.1:1234';try{await rejectBefore({},'owner_transport_target_unsupported');}finally{delete process.env.OPENCLAW_GATEWAY_URL;}count('public_url_override_closed');
   await rejectBefore({secret:async()=>({secretRefConfigured:true,unresolvedRefReason:'synthetic unresolved'})},'owner_transport_auth_unavailable');count('public_secretref_closed');
   await rejectBefore({scopes:['operator.write']},'owner_transport_scopes_unavailable');count('public_scope_grant_checked');
   await rejectBefore({secret:async()=>{turnAdmission.revoke();return {value:'synthetic-only'}}},'owner_turn_admission_expired');await reEnroll();count('public_revoke_during_bootstrap');
   await rejectBefore({beforeHello:()=>turnAdmission.revoke()},'owner_turn_admission_expired');await reEnroll();count('public_revoke_during_handshake');
   try{await rejectBefore({secret:async()=>{admissionClockOffset=61000;return {value:'synthetic-only'}}},'owner_turn_admission_expired');}finally{admissionClockOffset=0;}count('public_expiry_during_bootstrap');
   let calls=0;const hooks={deferHello:true};const sdk=fakePublicSdk(()=>{calls++;return {status:'accepted'}},hooks);gatewayTransport.setOwnerTurnSdkLoader(async()=>sdk);
   const x=admitted(),pending=gatewayTransport.submitOwnerTurn(x.params,x.options);for(let i=0;i<20&&!sdk.getClient();i++)await new Promise(r=>setTimeout(r,5));sdk.getClient().hello();sdk.getClient().hello();await pending;assert.equal(calls,1);assert.ok(hooks.stops);count('public_one_request_and_close');
  }

  // Synthetic write executor: never executes a real capability. It denies caller=other.
  {let x=await submit({sign:false,text:'p1-write unsigned',sessionId:'write-unsigned'});
   assert.equal(x.response.body.ownerAdmission.owner,false);assert.equal(x.response.body.state,'failed');
   assert.ok(readLines(helperLog).filter(c=>c.message==='p1-write unsigned').every(c=>c.caller==='other'));count('execute_unsigned_never_owner');
   const body=JSON.stringify({instruction:'p1-write invalid nonce',sessionId:'write-invalid',clientRunId:'p1-write-invalid-1'});
   const invalid=proof({body,clientRunId:'p1-write-invalid-1',sessionId:'write-invalid',n:'bad'});
   const refused=await request('POST','/v1/runs',body,invalid);assert.equal(refused.body.ownerAdmission.owner,false);assert.equal(refused.body.state,'failed');
   assert.ok(readLines(helperLog).filter(c=>c.message==='p1-write invalid nonce').every(c=>c.caller==='other'));count('execute_invalid_nonce_never_owner');
   x=await submit({text:'p1-write valid',sessionId:'write-valid'});assert.equal(x.response.body.ownerAdmission.owner,true);assert.equal(x.response.body.state,'done');
   assert.equal(readLines(helperLog).filter(c=>c.message==='p1-write valid'&&c.executing&&c.caller==='owner').length,1);count('execute_admitted_owner');
   const pending=submit({text:'p1-write revoke-resolution',sessionId:'write-revoked'});
   for(let i=0;i<300&&!readLines(helperLog).some(c=>c.message==='p1-write revoke-resolution');i++)await new Promise(r=>setTimeout(r,10));
   assert.ok(readLines(helperLog).some(c=>c.message==='p1-write revoke-resolution'));
   turnAdmission.revoke();fs.writeFileSync(path.join(root,'resolution-release'),'release');
   const expired=await pending;assert.equal(expired.response.body.accepted,false);
   assert.equal(readLines(helperLog).filter(c=>c.message==='p1-write revoke-resolution'&&c.executing).length,0);count('execute_revoked_during_resolution_refused');
   const again=await biometricApprove('owner.turn_admission.enroll',KEY,KEY);assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(again),owner)).status,200);
  }

  // Voice effects use the same one-use raw-body native proof, never a clarification as a grant.
  {const pathName='/v1/extensions/claw-live/capability';
   const cap=async(text,{sign=true,sessionId='voice-cap-fixture',clarificationId,headers}={})=>{const clientRunId='voice-cap-'+crypto.randomUUID(),body=JSON.stringify({request:text,sessionId,clientRunId,...(clarificationId?{clarificationId}:{})});return request('POST',pathName,body,{...(sign?proof({pathName,body,clientRunId,sessionId}):{}),...(headers||{})});};
   const before=readLines(helperLog).length;let x=await cap('p1-write voice unsigned',{sign:false});assert.equal(x.status,403);assert.equal(readLines(helperLog).length,before);count('voice_capability_unsigned_before_resolution');
   x=await cap('p1-write voice invalid',{headers:{'x-samantha-admission-nonce':'bad'}});assert.equal(x.status,403);assert.equal(readLines(helperLog).length,before);count('voice_capability_invalid_nonce_before_resolution');
   x=await cap('p1-write voice valid');assert.equal(x.status,200);assert.equal(x.body.ownerAdmission.owner,true);assert.equal(x.body.state,'done');
   assert.equal(readLines(helperLog).filter(c=>c.message==='p1-write voice valid'&&c.executing&&c.caller==='owner').length,1);count('voice_capability_admitted_prepared_execute');
   const clar=await cap('ambigu voice-fixture');assert.equal(clar.status,200);assert.equal(clar.body.state,'needs_clarification');
   const prior=readLines(helperLog).length;assert.equal((await cap('p1-write clarification no grant',{sign:false,clarificationId:clar.body.clarificationId})).status,403);assert.equal(readLines(helperLog).length,prior);count('voice_clarification_never_grants_admission');
   assert.equal((await cap('p1-write other session',{sessionId:'voice-cap-other',clarificationId:clar.body.clarificationId})).status,400);assert.equal(readLines(helperLog).length,prior);count('voice_clarification_bound_session');
   fs.rmSync(path.join(root,'resolution-release'),{force:true});
   const pending=cap('p1-write capability-revoke-resolution',{sessionId:'voice-cap-revoked'});
   for(let i=0;i<300&&!readLines(helperLog).some(c=>c.message==='p1-write capability-revoke-resolution');i++)await new Promise(r=>setTimeout(r,10));
   assert.ok(readLines(helperLog).some(c=>c.message==='p1-write capability-revoke-resolution'));turnAdmission.revoke();fs.writeFileSync(path.join(root,'resolution-release'),'release');
   assert.equal((await pending).status,403);assert.equal(readLines(helperLog).filter(c=>c.message==='p1-write capability-revoke-resolution'&&c.executing).length,0);count('voice_capability_revoked_during_resolution');
   const again=await biometricApprove('owner.turn_admission.enroll',KEY,KEY);assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(again),owner)).status,200);
  }

  // --- 7. Révocation : signée par la clé enrôlée ; ensuite non-owner. Un tour déjà remis au Gateway n'est pas touché.
  assert.equal((await request('DELETE','/v1/owner-admission/enrollment','{"operationId":"revoke-0001"}',owner)).status,403,'révocation non signée');
  {const body='{"operationId":"revoke-0002"}';assert.equal((await request('DELETE','/v1/owner-admission/enrollment',body,{...owner,...proof({method:'DELETE',pathName:'/v1/owner-admission/enrollment',body,clientRunId:'revoke-0002',sessionId:'owner-admission',key:rogue})})).status,403);}
  {// Ticket émis, révocation avant la remise : la remise retombe en non-owner.
   const body=Buffer.from('{"x":1}');const h=proof({body:body.toString(),clientRunId:'p1-race-0001',sessionId:'race'});
   const admitted=turnAdmission.verifyRequest({method:'POST',path:'/v1/runs',headers:h,rawBody:body,clientRunId:'p1-race-0001',sessionId:'race'});assert.equal(admitted.admitted,true);
   const body2='{"operationId":"revoke-0003"}';const rv=await request('DELETE','/v1/owner-admission/enrollment',body2,{...owner,...proof({method:'DELETE',pathName:'/v1/owner-admission/enrollment',body:body2,clientRunId:'revoke-0003',sessionId:'owner-admission'})});
   assert.equal(rv.status,200);assert.equal(rv.body.state,'revoked');
   assert.equal(turnAdmission.isCurrent(admitted.ticket,{clientRunId:'p1-race-0001',sessionId:'race'}),false);
   await assert.rejects(()=>require('../dist/companion/openclawAgentClient').submitToOpenClawAgent('Mémoire','voice-revoked','race',{admission:admitted.ticket,clientRunId:'p1-race-0001',voiceDelegation:true}),/voice_owner_admission_required/);count('voice_revoked_refused');
   const client=require('../dist/companion/openclawAgentClient');const res=await client.submitToOpenClawAgent('tour','p1-race-run','race',{authority:'owner',admission:admitted.ticket,clientRunId:'p1-race-0001'});
   assert.equal(res.ownerTransport,'write_cli');count('revocation_before_dispatch');}
  r=await submit();assert.equal(lastReason(),'not_enrolled');assert.equal((await settled(r.runId)).transport,'cli_write');count('after_revocation_non_owner');
  // Ré-enrôlement : nouvelle époque ; un ancien ticket ne redevient jamais courant.
  {const again=await biometricApprove('owner.turn_admission.enroll',KEY,KEY);assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(again),owner)).status,200);
   const body=Buffer.from('{}');const t=turnAdmission.verifyRequest({method:'POST',path:'/v1/runs',headers:proof({body:'{}',clientRunId:'p1-epoch-0001',sessionId:'e'}),rawBody:body,clientRunId:'p1-epoch-0001',sessionId:'e'});assert.equal(t.admitted,true);
   const again2=await biometricApprove('owner.turn_admission.enroll',KEY,KEY);await request('POST','/v1/owner-admission/enrollment',enrollBody(again2),owner);
   assert.equal(turnAdmission.isCurrent(t.ticket,{clientRunId:'p1-epoch-0001',sessionId:'e'}),false);count('reenroll_new_epoch');}
  // Révocation opérateur : suppression du fichier, effet immédiat.
  fs.unlinkSync(path.join(state,'owner-turn-admission.json'));r=await submit();assert.equal(lastReason(),'not_enrolled');count('operator_revocation_file');

  // --- 8. Compatibilité : drapeau OFF par défaut ; ON ne rend que le contexte canonique, jamais l'admin.
  process.env.CLAWMOBILE_RUNS_LEGACY_LOOPBACK_CONTEXT='1';
  {const before=sdkCalls.length;const x=await submit({sign:false});const t=await settled(x.runId);assert.equal(t.transport,'cli_write');assert.equal(sdkCalls.length,before);count('legacy_flag_never_admin');}
  delete process.env.CLAWMOBILE_RUNS_LEGACY_LOOPBACK_CONTEXT;

  // --- 9. Frontière statique : seule la soumission de tour appelle la connexion admin, derrière isCurrent ; méthode figée.
  const src=f=>fs.readFileSync(path.join(__dirname,'../src/companion',f),'utf8');
  const users=fs.readdirSync(path.join(__dirname,'../src/companion')).filter(f=>f.endsWith('.ts')&&f!=='ownerTurnGateway.ts'&&src(f).includes('submitOwnerTurn'));
  assert.deepEqual(users,['openclawAgentClient.ts']);
  const agent=src('openclawAgentClient.ts');assert.ok(agent.indexOf('turnAdmission.isCurrent')<agent.indexOf('submitOwnerTurn(params'));
  assert.ok(!/callOpenClawGateway[\s\S]{0,400}submitOwnerTurn/.test(agent.slice(agent.indexOf('export async function callOpenClawGateway'))),'callOpenClawGateway (Control) n’emprunte jamais la connexion admin');
  assert.match(src('ownerTurnGateway.ts'),/export const OWNER_TURN_METHOD = "agent";/);
  assert.ok(!/authority:isLoopback/.test(src('server.ts').slice(src('server.ts').indexOf('routePath === "/runs"'),src('server.ts').indexOf('routePath === "/runs"')+3000)),'heuristique loopback retirée de /runs');
  count('static_boundary');
  // Capture S24 #172 : seul un `operator.admin` accordé donne le bit ; les scopes demandés ici sont ceux capturés comme accordés.
  const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/p1/p1-owner-transport-admission.json'),'utf8'));
  const write=fixture.gateway_handshake_cases.find(c=>c.case==='valid_token_cli_write_only');assert.deepEqual(write.grantedScopes,['operator.write']);assert.equal(write.senderIsOwnerDerived,false);
  assert.equal(fixture.findings.companion_native_admission_authenticated,false);assert.equal(fixture.findings.owner_bit_scope.startsWith('connexion'),true);count('fixture_s24');

  // S24 11/10 : $PREFIX/bin/openclaw est un script enveloppe ; la racine vient de <prefix>/lib/node_modules/openclaw.
  {const prefix=path.join(root,'termux-prefix'),bin=path.join(prefix,'bin'),pkg=path.join(prefix,'lib','node_modules','openclaw');
   fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(pkg,{recursive:true});
   fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'openclaw',version:'2026.9.6'}));
   fs.writeFileSync(path.join(bin,'openclaw'),'#!/bin/sh\nexec node '+path.join(pkg,'openclaw.mjs')+' "$@"\n',{mode:0o755});
   const found=await gatewayTransport.installedPackageRoot(path.join(bin,'openclaw'));
   assert.equal(found.root,fs.realpathSync(pkg));assert.equal(found.version,'2026.9.6');
   fs.rmSync(path.join(pkg,'package.json'));
   await assert.rejects(()=>gatewayTransport.installedPackageRoot(path.join(bin,'openclaw')),e=>e.code==='owner_transport_unavailable'||/owner_transport_unavailable/.test(String(e.message)));
   count('wrapper_binary_npm_global_root');}
  console.log(JSON.stringify({test:'P1 native owner admission',passed:Object.keys(counts).length,cases:counts}));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));gateway.close();fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
