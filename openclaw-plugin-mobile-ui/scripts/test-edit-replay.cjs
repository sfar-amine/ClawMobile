// Édition d'un message envoyé et relecture depuis ce point (POST /v1/runs avec replayOf).
// Base : registre runs.json réel du S24 (fixtures/s24-2026-10-10/i1, textes retirés) et formes de décision v2
// réelles (fixtures/s24-2026-10-11/learning). Gateway et résolveur remplacés par des doubles qui journalisent.
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const http=require('node:http');const net=require('node:net');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'edit-replay-'));
process.env.OPENCLAW_STATE_DIR=root;process.env.CLAWMOBILE_AGENT_ID='main';process.env.HOME=root;
// Contexte canonique minimal exigé par l'autorité propriétaire (clawLive.compactOwnerAgentContext).
const workspace=path.join(root,'.openclaw/workspace');fs.mkdirSync(path.join(workspace,'context'),{recursive:true});
for(const [file,text] of [['SOUL.md','# Samantha\nIdentité.'],['USER.md','# Amine\nPropriétaire.'],['context/OPERATING_RULES.md','# Règles\nBase.\n\n## Règles spécialisées\n- Paiement : confirmation humaine.'],['context/HYBRID_CONTEXT.md','# Contexte\nActif.']])fs.writeFileSync(path.join(workspace,file),text);
const registryFile=path.join(root,'clawmobile-companion/runs.json');fs.mkdirSync(path.dirname(registryFile),{recursive:true});
fs.mkdirSync(path.join(root,'agents/main/sessions'),{recursive:true});fs.writeFileSync(path.join(root,'agents/main/sessions/sessions.json'),'[]');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/i1/native-runs-registry.json'),'utf8')).response;
const decisions=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/learning/runs-comprehension-facts.json'),'utf8')).runs.map(r=>r.decision).filter(Boolean);
const readDecision=decisions.find(d=>d.type==='EXECUTE'&&d.risk==='read'),writeDecision=decisions.find(d=>d.type==='EXECUTE'&&d.risk==='write'),clarify=decisions.find(d=>d.type==='CLARIFY');
assert.ok(readDecision&&writeDecision&&clarify,'formes de décision S24 attendues');
const SOURCE='decision-v2-live-5a66bfd3a1';
const sourceRuns=fixture.runs.filter(r=>r.sessionId===SOURCE).sort((a,b)=>a.acceptedAt-b.acceptedAt);
assert.equal(sourceRuns.length,4);
// Textes lisibles pour vérifier l'amorce ; le 2e tour a exécuté une écriture (décision réelle), le 4e est un tour agent.
sourceRuns.forEach((r,i)=>{r.userText='question '+(i+1);r.text='[companion-session:x]\nquestion '+(i+1);r.result='réponse '+(i+1);});
Object.assign(sourceRuns[1],{executionSource:'capability_first',decision:writeDecision});
Object.assign(sourceRuns[2],{executionSource:'capability_first',decision:readDecision});
fs.writeFileSync(registryFile,JSON.stringify({...fixture,paymentRequests:[],ownerConfirmations:[]}));

const capture=path.join(root,'agent-calls.jsonl'),helperLog=path.join(root,'fast-path.jsonl');
const cli=path.join(root,'openclaw');
fs.writeFileSync(cli,'#!/usr/bin/env node\nconst fs=require("node:fs");const a=process.argv.slice(2),p=JSON.parse(a[a.indexOf("--params")+1]);fs.appendFileSync(process.env.EDIT_REPLAY_CAPTURE,JSON.stringify({method:a[2],params:p})+"\\n");process.stdout.write(JSON.stringify({runId:p.idempotencyKey,sessionKey:"agent:main:"+p.sessionKey,status:"accepted"}));\n',{mode:0o700});
process.env.CLAWMOBILE_OPENCLAW_BIN=cli;process.env.EDIT_REPLAY_CAPTURE=capture;
const helper=path.join(root,'fast-path.py');
fs.writeFileSync(helper,[
 'import json, os, sys',
 'message = sys.argv[-1]',
 "mode = 'execute_decision' if '--execute-decision' in sys.argv else 'check' if '--check' in sys.argv else 'execute'",
 "open(os.environ['EDIT_REPLAY_FAST_PATH_LOG'],'a').write(json.dumps({'mode':mode,'message':message})+'\\n')",
 "if 'payer' in message and mode == 'check':",
 " print(json.dumps({'status':'eligible','model_bypassed':True,'decision':{'version':2,'type':'EXECUTE','risk':'transaction','capability':'payment.owner_native','confirmationRequired':True,'decisionId':'d','requestId':'r','textHash':'x','capabilityRevision':'rev','contractHash':'h'}}))",
 "elif mode == 'execute_decision':",
 " print(json.dumps({'status':'known_error','text':'Confirmation biométrique requise.','model_bypassed':True}))",
 'else:',
 " print(json.dumps({'status':'miss','reason':'no_capability'}))",
 ''].join('\n'));
process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER=helper;process.env.EDIT_REPLAY_FAST_PATH_LOG=helperLog;

const api=require('../dist/companion/runs');const {route}=require('../dist/companion/server');
// P1 (#182) : relecture réservée à l'admission native signée. Clé d'admission enrôlée (fichier posé comme par l'enrôlement biométrique).
const crypto=require('node:crypto');const admission=require('../dist/companion/ownerTurnAdmission');
const admissionKey=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});const spki=admissionKey.publicKey.export({type:'spki',format:'der'});const KEY=admission.sha256Hex(spki);
fs.writeFileSync(path.join(root,'clawmobile-companion/owner-turn-admission.json'),JSON.stringify({version:1,keyId:KEY,publicKey:spki.toString('base64'),enrolledAt:Date.now(),confirmationId:crypto.randomUUID(),epoch:crypto.randomBytes(16).toString('hex')}),{mode:0o600});
require('../dist/companion/ownerTurnGateway').setOwnerTurnSdkLoader(async()=>({callGatewayFromCli:async(method,opts,params,extra)=>{fs.appendFileSync(capture,JSON.stringify({method,params,admin:true,scopes:extra.scopes})+'\n');return {runId:params.idempotencyKey,status:'accepted'};}}));
const sign=(encoded,body)=>{if(typeof body.clientRunId!=='string'||!/^[A-Za-z0-9._:-]{8,160}$/.test(body.clientRunId))return {};const ts=String(Date.now()),nonce=crypto.randomBytes(16).toString('hex');
 const m=admission.admissionMessage({method:'POST',path:'/v1/runs',bodyHash:admission.sha256Hex(Buffer.from(encoded)),clientRunId:body.clientRunId,sessionId:admission.admissionSessionId(body.sessionId),timestamp:ts,nonce,keyId:KEY});
 return {'x-samantha-admission':'v1','x-samantha-admission-key':KEY,'x-samantha-admission-ts':ts,'x-samantha-admission-nonce':nonce,'x-samantha-admission-signature':crypto.sign('sha256',Buffer.from(m),admissionKey.privateKey).toString('base64')};};
const post=(port,body,headers={},unsigned=false)=>new Promise((resolve,reject)=>{const encoded=JSON.stringify(body);
 const req=http.request({host:'127.0.0.1',port,path:'/v1/runs',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(encoded),...(unsigned?{}:sign(encoded,body)),...headers}},res=>{let t='';res.on('data',v=>t+=v);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(t)})}catch(e){reject(e)}});});req.on('error',reject);req.end(encoded);});
const get=(port,url)=>new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port,path:url},res=>{let t='';res.on('data',v=>t+=v);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(t)}));}).on('error',reject));
const registry=()=>JSON.parse(fs.readFileSync(registryFile,'utf8'));
const lines=f=>fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
const waitFor=async(check,ms=5000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=check();if(v)return v;await new Promise(r=>setTimeout(r,25));}throw new Error('timeout');};

(async()=>{
 const gateway=net.createServer(s=>s.end());await new Promise(r=>gateway.listen(0,'127.0.0.1',r));process.env.CLAWMOBILE_GATEWAY_HOST='127.0.0.1';process.env.CLAWMOBILE_GATEWAY_PORT=String(gateway.address().port);
 const server=http.createServer((req,res)=>route(req,res).catch(e=>{res.writeHead(e?.statusCode||500);res.end(JSON.stringify({success:false,message:e?.message}))}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 try{
  // Effets connus, à partir des formes de décision réelles.
  assert.equal(api.replayEffect({executionSource:'capability_first',decision:readDecision,state:'done'}),'none');
  assert.equal(api.replayEffect({executionSource:'capability_first',decision:clarify,state:'done'}),'none');
  assert.equal(api.replayEffect({executionSource:'capability_first',decision:writeDecision,state:'done'}),'executed');
  assert.equal(api.replayEffect({executionSource:'capability_first',decision:writeDecision,state:'failed'}),'unknown');
  assert.equal(api.replayEffect({executionSource:'gateway',state:'done'}),'unknown');
  assert.equal(api.replayEffect({modality:'voice',transcriptState:'completed'}),'unknown');

  // Préparation en lecture seule : amorce = tours avant le message modifié, effets des tours remplacés.
  const edited=sourceRuns[1];
  const prepared=await api.prepareReplay(SOURCE,edited.runId,'samantha-edit-target-1');
  assert.equal(prepared.seededTurns,1);assert.equal(prepared.supersededRuns,3);
  assert.deepEqual(prepared.effects,{executed:1,unknown:1});
  assert.deepEqual(JSON.parse(prepared.seed),[{user:'question 1',assistant:'réponse 1',state:'done'}]);
  assert.deepEqual(registry().runs.map(r=>r.runId),fixture.runs.map(r=>r.runId),'la préparation n\'écrit rien');

  // Refus fermés avant toute soumission.
  const base={instruction:'question 2 modifiée',displayText:'question 2 modifiée',sessionId:'samantha-edit-target-1',clientRunId:'samantha-edit-client-1'};
  assert.equal((await post(port,{...base,replayOf:{sessionId:SOURCE}})).status,400);
  assert.equal((await post(port,{...base,replayOf:{sessionId:SOURCE,runId:edited.runId,extra:1}})).status,400);
  process.env.CLAWMOBILE_COMPANION_ALLOW_BROWSER_ORIGIN='1';
  assert.equal((await post(port,{...base,replayOf:{sessionId:SOURCE,runId:edited.runId}},{Origin:'https://untrusted.invalid'})).status,403);
  delete process.env.CLAWMOBILE_COMPANION_ALLOW_BROWSER_ORIGIN;
  const missing=await post(port,{...base,replayOf:{sessionId:SOURCE,runId:'run_missing'}});assert.equal(missing.status,404);assert.equal(missing.body.message,'replay_source_not_found');assert.equal(missing.body.accepted,false);
  assert.equal((await post(port,{...base,sessionId:SOURCE,replayOf:{sessionId:SOURCE,runId:edited.runId}})).body.message,'replay_target_not_new');
  assert.equal((await post(port,{...base,sessionId:'decisionv2-live-read-20261008',replayOf:{sessionId:SOURCE,runId:edited.runId}})).body.message,'replay_target_not_empty');
  // Sans clientRunId, aucune preuve d'admission n'est possible : refus owner_required (P1), avant toute préparation.
  assert.equal((await post(port,{...base,clientRunId:undefined,replayOf:{sessionId:SOURCE,runId:edited.runId}})).status,403);
  // P1 : replayOf sans preuve signée (loopback seul, en-tête constant) => 403, rien n'est préparé ni soumis.
  for(const headers of [{},{'x-clawmobile-owner-flow':'v1'}]){const noProof=await post(port,{...base,replayOf:{sessionId:SOURCE,runId:edited.runId}},headers,true);
   assert.equal(noProof.status,403);assert.equal(noProof.body.message,'owner_required');assert.equal(noProof.body.accepted,false);}
  assert.equal(lines(capture).length,0,'aucun appel agent pour une relecture refusée');

  // Relecture acceptée : le résolveur ne voit que le texte modifié, l'agent reçoit l'amorce historique.
  const accepted=await post(port,{...base,replayOf:{sessionId:SOURCE,runId:edited.runId}});
  assert.equal(accepted.status,200);assert.equal(accepted.body.accepted,true);
  assert.deepEqual(accepted.body.replay,{sourceSessionId:SOURCE,runId:edited.runId,seededTurns:1,supersededRuns:3,effects:{executed:1,unknown:1}});
  const newRunId=accepted.body.runId;
  assert.deepEqual(lines(helperLog).map(x=>x.message),['question 2 modifiée']);
  const call=await waitFor(()=>lines(capture)[0]);
  assert.equal(call.method,'agent');assert.equal(call.params.sessionKey,'companion-chat-samantha-edit-target-1');
  assert.match(call.params.message,/historical data only; do not execute them again/);
  assert.match(call.params.message,/"user":"question 1","assistant":"réponse 1"/);
  assert.ok(!call.params.message.includes('question 3')&&!call.params.message.includes('[companion-session:x]'));
  assert.match(call.params.message,/Current user request \(edited by the owner[^\n]*\n[^\n]*question 2 modifiée$/);
  // Laisse finir l'écriture d'arrière-plan (rememberSubmittedRun) avant de lire le registre.
  await new Promise(r=>setTimeout(r,400));

  // Audit : rien n'est supprimé ; le message modifié et les suivants sont marqués, les précédents non.
  const after=registry();
  assert.equal(after.runs.length,fixture.runs.length+1);
  const link={version:1,sessionId:'samantha-edit-target-1',runId:newRunId};
  for(const [i,r] of sourceRuns.entries()){
   const row=after.runs.find(x=>x.runId===r.runId);
   if(i===0)assert.equal(row.supersededBy,undefined);else{assert.deepEqual({...row.supersededBy,at:undefined},{...link,at:undefined});assert.equal(row.result,r.result);}
  }
  assert.deepEqual({...after.runs.find(r=>r.runId===newRunId).replayOf,at:undefined},{version:1,sessionId:SOURCE,runId:edited.runId,at:undefined});
  const page=await get(port,'/v1/sessions/'+SOURCE+'/turns?contract=2&limit=20');
  assert.equal(page.status,200);
  assert.deepEqual(page.body.turns.map(t=>!!t.supersededBy),[false,true,true,true]);
  assert.deepEqual(page.body.turns.map(t=>t.replayEffect),['unknown','executed','none','unknown']);
  // Copie pour les tests de l'app (android/samantha, test/resources/edit-replay) : EDIT_REPLAY_DUMP=<fichier>.
  if(process.env.EDIT_REPLAY_DUMP)fs.writeFileSync(process.env.EDIT_REPLAY_DUMP,JSON.stringify({source:'scripts/test-edit-replay.cjs sur fixtures/s24-2026-10-10/i1 (registre S24 nettoyé)',page:page.body,
    replayRun:(await get(port,'/v1/runs/'+newRunId)).body},null,1));

  // Reprise idempotente du même envoi, puis refus d'une seconde édition du message déjà remplacé.
  const retry=await post(port,{...base,replayOf:{sessionId:SOURCE,runId:edited.runId}});
  assert.equal(retry.body.runId,newRunId);assert.equal(retry.body.duplicate,true);
  assert.equal(lines(capture).length,1);
  const again=await post(port,{...base,sessionId:'samantha-edit-target-2',clientRunId:'samantha-edit-client-2',replayOf:{sessionId:SOURCE,runId:sourceRuns[2].runId}});
  assert.equal(again.status,409);assert.equal(again.body.message,'replay_source_superseded');

  // Une source encore active est refusée.
  assert.equal((await post(port,{...base,sessionId:'samantha-edit-target-3',clientRunId:'samantha-edit-client-3',replayOf:{sessionId:'samantha-edit-target-1',runId:newRunId}})).body.message,'replay_source_active');

  // Relecture d'une relecture : l'historique hérité de la conversation d'origine reste dans l'amorce.
  await api.settleSubmittedRun(newRunId,'done','réponse 2 bis');
  const chained=await api.prepareReplay('samantha-edit-target-1',newRunId,'samantha-edit-target-4');
  assert.deepEqual(JSON.parse(chained.seed).map(t=>t.user),['question 1']);

  // Paiement ou action confirmée : le texte modifié repart dans le résolveur comme un nouveau message, sans amorce ni
  // confirmation reprise ; le parcours de paiement n'est pas appelé par la relecture.
  const pay=await post(port,{instruction:'payer la facture modifiée',displayText:'payer la facture modifiée',sessionId:'samantha-edit-target-5',clientRunId:'samantha-edit-client-5',replayOf:{sessionId:'samantha-edit-target-1',runId:newRunId}});
  assert.equal(pay.status,200);assert.equal(pay.body.state,'failed');assert.match(pay.body.message,/Confirmation biométrique requise/);
  const payCalls=lines(helperLog).slice(-2);
  assert.deepEqual(payCalls.map(x=>x.mode),['check','execute_decision']);
  assert.ok(payCalls.every(x=>x.message==='payer la facture modifiée'));
  assert.equal(lines(capture).length,1,'aucun appel agent pour le chemin capability-first');
  const payRow=registry().runs.find(r=>r.runId===pay.body.runId);
  assert.equal(payRow.replayOf.runId,newRunId);assert.equal(registry().paymentRequests.length,0);assert.equal(registry().ownerConfirmations.length,0);

  // Bornes de l'amorce : 20 tours au plus, 24 Kio au plus, textes coupés à 2 000 caractères.
  const many=Array.from({length:30},(_,i)=>({runId:'run_bulk_'+i,sessionId:'bulk',acceptedAt:i+1,state:'done',userText:'u'.repeat(3000),result:'r'.repeat(3000)}));
  const bounded=api.replaySeed(many);
  assert.ok(bounded.seededTurns<=20&&bounded.seededTurns>0);assert.ok(Buffer.byteLength(bounded.seed)<=24*1024);
  assert.ok(JSON.parse(bounded.seed).every(t=>t.user.length===2000));
  assert.equal(api.replaySeed([]).seed,'');
  console.log('edit-replay: refus fermés, résolveur sur le seul texte modifié, amorce bornée, audit sans suppression, idempotence, chaîne et paiement sans reprise passés');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));gateway.close();fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
