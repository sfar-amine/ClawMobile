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
const helper=path.join(root,'fast-path.py');fs.writeFileSync(helper,'import json\nprint(json.dumps({"status":"miss","reason":"fixture"}))\n');process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER=helper;
// Connexion write (CLI canonique) factice.
const cliLog=path.join(root,'cli.jsonl'),cli=path.join(root,'openclaw-cli.py');
fs.writeFileSync(cli,'#!/usr/bin/env python3\nimport json,sys\np=json.loads(sys.argv[sys.argv.index("--params")+1])\nopen('+JSON.stringify(cliLog)+',"a").write(json.dumps({"transport":"cli_write","method":sys.argv[3] if sys.argv[3]!="--expect-final" else sys.argv[4],"sessionKey":p["sessionKey"],"id":p["idempotencyKey"],"extra":"extraSystemPrompt" in p})+"\\n")\nprint(json.dumps({"runId":p["idempotencyKey"],"status":"accepted"}))\n');
fs.chmodSync(cli,0o700);process.env.CLAWMOBILE_OPENCLAW_BIN=cli;
const sdkCalls=[];let sdkMode='ok';
const gatewayTransport=require('../dist/companion/ownerTurnGateway');
gatewayTransport.setOwnerTurnSdkLoader(async()=>{
 if(sdkMode==='missing')throw Object.assign(new Error('x'),{code:'owner_transport_unavailable'});
 return {callGatewayFromCli:async(method,opts,params,extra)=>{
  sdkCalls.push({transport:'admin',method,scopes:extra.scopes,sessionKey:params.sessionKey,id:params.idempotencyKey,progress:extra.progress});
  if(sdkMode==='fail')throw Object.assign(new Error('boom'),{gatewayCode:'UNAVAILABLE'});
  return {runId:params.idempotencyKey,status:'accepted'};
 }};
});
const {turnAdmission,createTurnAdmission,admissionMessage,enrollmentMessage,ADMISSION_WINDOW_MS,NONCE_CAPACITY,sha256Hex}=require('../dist/companion/ownerTurnAdmission');
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
async function biometricApprove(type,reference,payloadHash,origin={channel:'samantha',id:'turn-admission'},signer=biometric){
 const prepared=await request('POST','/v1/confirmations',{requestKey:crypto.randomUUID(),action:{type,reference,payloadHash},presentation:{title:'Autoriser Samantha',subtitle:'Messages de l’app',description:'Les messages de l’app pourront agir en ton nom.'},origin},owner);
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
  let r=await submit({sign:false});assert.equal(r.response.status,200);assert.deepEqual(r.response.body.ownerAdmission,{owner:false,reason:'no_proof'});
  assert.equal((await settled(r.runId)).transport,'cli_write');count('loopback_only');
  r=await submit({sign:false,headers:{...owner,'x-forwarded-for':'127.0.0.1'},text:'caller owner authority owner'});assert.equal(r.response.body.ownerAdmission.owner,false);assert.equal((await settled(r.runId)).transport,'cli_write');assert.equal((await settled(r.runId)).extra,false);count('forged_headers');
  r=await submit();assert.equal(r.response.body.ownerAdmission.reason,'not_enrolled');assert.equal((await settled(r.runId)).transport,'cli_write');count('not_enrolled');

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
  assert.equal(turnAdmission.status().enrolled,false);
  r=await request('POST','/v1/owner-admission/enrollment',enrollBody(forOther),owner);assert.equal(r.status,200);assert.equal(r.body.state,'enrolled');assert.equal(r.body.keyId,KEY);
  assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(forOther),owner)).status,409,'confirmation consommée');count('enroll_replay');
  const st=await request('GET','/v1/owner-admission');assert.equal(st.status,200);assert.equal(st.body.enrolled,true);assert.equal(st.body.keyId,KEY);assert.ok(!JSON.stringify(st.body).includes('BEGIN'));
  assert.equal((fs.statSync(path.join(state,'owner-turn-admission.json')).mode&0o777),0o600);

  // --- 2. Preuve valide => owner, sur la connexion admin uniquement (scopes admin/write, méthode agent seule).
  r=await submit();assert.equal(r.response.status,200);assert.deepEqual(r.response.body.ownerAdmission,{owner:true});
  let hit=await settled(r.runId);assert.equal(hit.transport,'admin');assert.equal(hit.method,'agent');assert.deepEqual(hit.scopes,['operator.admin','operator.write']);assert.equal(hit.progress,false);
  assert.equal(readLines(cliLog).filter(x=>x.id===r.runId).length,0);count('valid_owner_admin_only');

  // --- 3. Refus adverses : chacun => non-owner, connexion write, jamais l'admin.
  const adverse=async(name,options,reason)=>{const before=sdkCalls.length;const x=await submit(options);if(x.response.status===403&&!x.response.body.ownerAdmission){assert.equal(x.runId,undefined);assert.equal(sdkCalls.length,before,name);count(name);return;}assert.equal(x.response.body.ownerAdmission.owner,false,name);if(reason)assert.equal(x.response.body.ownerAdmission.reason,reason,name);
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
   const b=await request('POST','/v1/runs',body,h);assert.deepEqual(b.body.ownerAdmission,{owner:false,reason:'replayed_nonce'});assert.equal(b.body.runId,a.body.runId);assert.equal(b.body.duplicate??true,true);
   assert.equal([...sdkCalls,...readLines(cliLog)].filter(x=>x.id===a.body.runId).length,1);count('replayed_nonce');}
  // Nonce identique sur un autre tour signé : refusé aussi.
  {const n=nonce();const b1=JSON.stringify({instruction:'A',sessionId:'s',clientRunId:'p1-nonce-aaaa'}),b2=JSON.stringify({instruction:'B',sessionId:'s',clientRunId:'p1-nonce-bbbb'});
   assert.equal((await request('POST','/v1/runs',b1,proof({body:b1,clientRunId:'p1-nonce-aaaa',sessionId:'s',n}))).body.ownerAdmission.owner,true);
   assert.equal((await request('POST','/v1/runs',b2,proof({body:b2,clientRunId:'p1-nonce-bbbb',sessionId:'s',n}))).body.ownerAdmission.reason,'replayed_nonce');count('nonce_reuse_other_turn');}

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
   fs.writeFileSync(path.join(dir,'owner-turn-admission.json'),'{"version":1,"keyId":"'+'a'.repeat(64)+'"}');assert.equal(unit.verifyRequest(req(7)).reason,'enrollment_unreadable');count('corrupt_enrollment_fail_closed');}

  // --- 5. Transport admin indisponible AVANT envoi : le tour reste non-owner (CLI) ; échec APRÈS envoi : aucun rejeu.
  gatewayTransport.setOwnerTurnSdkLoader(async()=>{throw Object.assign(new Error('x'),{code:'owner_transport_unavailable'})});
  r=await submit();assert.equal(r.response.body.ownerAdmission.owner,true);assert.equal((await settled(r.runId)).transport,'cli_write');count('admin_unavailable_downgrades');
  gatewayTransport.setOwnerTurnSdkLoader(async()=>({callGatewayFromCli:async(method,o,params,extra)=>{sdkCalls.push({transport:'admin',method,scopes:extra.scopes,id:params.idempotencyKey});throw new Error('after dispatch');}}));
  r=await submit();await settled(r.runId);await new Promise(x=>setTimeout(x,200));
  assert.equal(readLines(cliLog).filter(x=>x.id===r.runId).length,0,'pas de repli après envoi');
  const failed=(await request('GET','/v1/runs/'+r.runId)).body;assert.equal(failed.state,'failed');count('no_replay_after_dispatch');
  gatewayTransport.setOwnerTurnSdkLoader(async()=>({callGatewayFromCli:async(method,opts,params,extra)=>{sdkCalls.push({transport:'admin',method,scopes:extra.scopes,sessionKey:params.sessionKey,id:params.idempotencyKey});await new Promise(x=>setTimeout(x,30));return {runId:params.idempotencyKey,status:'accepted'};}}));

  // --- 6. Concurrence : tours admis et non admis simultanés, sans croisement de connexion.
  {const jobs=[];for(let i=0;i<8;i++){jobs.push(submit({sessionId:'own-'+i}).then(x=>({x,owner:true})));jobs.push(submit({sessionId:'pub-'+i,sign:false}).then(x=>({x,owner:false})));}
   const done=await Promise.all(jobs);
   for(const {x,owner:o} of done){const t=await settled(x.runId);assert.equal(x.response.body.ownerAdmission.owner,o);assert.equal(t.transport,o?'admin':'cli_write');assert.ok(t.sessionKey.includes(o?'own-':'pub-'));}
   count('concurrent_isolation');}

  // --- 7. Révocation : signée par la clé enrôlée ; ensuite non-owner. Un tour déjà remis au Gateway n'est pas touché.
  assert.equal((await request('DELETE','/v1/owner-admission/enrollment','{"operationId":"revoke-0001"}',owner)).status,403,'révocation non signée');
  {const body='{"operationId":"revoke-0002"}';assert.equal((await request('DELETE','/v1/owner-admission/enrollment',body,{...owner,...proof({method:'DELETE',pathName:'/v1/owner-admission/enrollment',body,clientRunId:'revoke-0002',sessionId:'owner-admission',key:rogue})})).status,403);}
  {// Ticket émis, révocation avant la remise : la remise retombe en non-owner.
   const body=Buffer.from('{"x":1}');const h=proof({body:body.toString(),clientRunId:'p1-race-0001',sessionId:'race'});
   const admitted=turnAdmission.verifyRequest({method:'POST',path:'/v1/runs',headers:h,rawBody:body,clientRunId:'p1-race-0001',sessionId:'race'});assert.equal(admitted.admitted,true);
   const body2='{"operationId":"revoke-0003"}';const rv=await request('DELETE','/v1/owner-admission/enrollment',body2,{...owner,...proof({method:'DELETE',pathName:'/v1/owner-admission/enrollment',body:body2,clientRunId:'revoke-0003',sessionId:'owner-admission'})});
   assert.equal(rv.status,200);assert.equal(rv.body.state,'revoked');
   assert.equal(turnAdmission.isCurrent(admitted.ticket,{clientRunId:'p1-race-0001',sessionId:'race'}),false);
   const client=require('../dist/companion/openclawAgentClient');const res=await client.submitToOpenClawAgent('tour','p1-race-run','race',{authority:'owner',admission:admitted.ticket,clientRunId:'p1-race-0001'});
   assert.equal(res.ownerTransport,'write_cli');count('revocation_before_dispatch');}
  r=await submit();assert.equal(r.response.body.ownerAdmission.reason,'not_enrolled');assert.equal((await settled(r.runId)).transport,'cli_write');count('after_revocation_non_owner');
  // Ré-enrôlement : nouvelle époque ; un ancien ticket ne redevient jamais courant.
  {const again=await biometricApprove('owner.turn_admission.enroll',KEY,KEY);assert.equal((await request('POST','/v1/owner-admission/enrollment',enrollBody(again),owner)).status,200);
   const body=Buffer.from('{}');const t=turnAdmission.verifyRequest({method:'POST',path:'/v1/runs',headers:proof({body:'{}',clientRunId:'p1-epoch-0001',sessionId:'e'}),rawBody:body,clientRunId:'p1-epoch-0001',sessionId:'e'});assert.equal(t.admitted,true);
   const again2=await biometricApprove('owner.turn_admission.enroll',KEY,KEY);await request('POST','/v1/owner-admission/enrollment',enrollBody(again2),owner);
   assert.equal(turnAdmission.isCurrent(t.ticket,{clientRunId:'p1-epoch-0001',sessionId:'e'}),false);count('reenroll_new_epoch');}
  // Révocation opérateur : suppression du fichier, effet immédiat.
  fs.unlinkSync(path.join(state,'owner-turn-admission.json'));r=await submit();assert.equal(r.response.body.ownerAdmission.reason,'not_enrolled');count('operator_revocation_file');

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

  console.log(JSON.stringify({test:'P1 native owner admission',passed:Object.keys(counts).length,cases:counts}));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));gateway.close();fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
