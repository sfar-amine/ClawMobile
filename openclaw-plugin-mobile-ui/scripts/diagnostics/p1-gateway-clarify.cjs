'use strict';
// Synthetic capability fixture and real Companion HTTP / real local public Gateway.
// This is not a S24 capture or Android/biometric qualification.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http'),assert=require('node:assert/strict');
module.exports=async({pair,keyId,admission,state,pluginRoot})=>{
 const root=process.env.OPENCLAW_HOME,helper=path.join(root,'clarify-fast-path.py'),log=path.join(root,'clarify-fast-path.jsonl');
 require('node:os').homedir=()=>root;const syntheticWorkspace=path.join(root,'.openclaw','workspace');fs.mkdirSync(path.join(syntheticWorkspace,'context'),{recursive:true});for(const [name,value] of [['SOUL.md','Synthetic isolated identity'],['USER.md','Synthetic isolated owner'],['context/OPERATING_RULES.md','Synthetic rules\n## Règles spécialisées\nNo external effect.\n'],['context/HYBRID_CONTEXT.md','Synthetic local continuity']])fs.writeFileSync(path.join(syntheticWorkspace,name),value);

 fs.writeFileSync(path.join(state,'runs.json'),JSON.stringify({version:1,runs:[],archivedSessionIds:[],ownerConfirmations:[],paymentRequests:[],runDeletions:[]}));
 fs.writeFileSync(helper,['import json,sys','m=sys.argv[-1]','mode="resolve" if "--resolve-clarification" in sys.argv else "check"',
 'open('+JSON.stringify(log)+',"a").write(json.dumps({"mode":mode})+"\\n")',
 'd=lambda k,i:{"version":2,"type":k,"decisionId":i,"requestId":i,"textHash":"x","capabilityRevision":"rev","contractHash":"hash"}',
 'if mode=="resolve": print(json.dumps({"status":"miss","resolution":{"text":"ATTACKER_DERIVED "+m}}))',
 'elif "ambigu" in m: print(json.dumps({"status":"clarification","text":"Consulter ou agir ?","model_bypassed":True,"decision":{**d("CLARIFY","isolated-clarify"),"clarification":{"question":"Consulter ou agir ?","choices":[{"intent":"read","label":"consulter"},{"intent":"act","label":"agir"}]}}}))',
 'else: print(json.dumps({"status":"miss","reason":"synthetic_isolated_fixture"}))',''].join('\n'));
 process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER=helper;
 const {route}=require(path.join(pluginRoot,'dist/companion/server'));
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.statusCode=500;res.end('{}')}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 async function post(text,sign){const sessionId='p1-clarify',clientRunId='isolated-clarify-'+crypto.randomUUID(),body=JSON.stringify({instruction:text,displayText:text,sessionId,clientRunId});let headers={'content-type':'application/json','content-length':Buffer.byteLength(body)};
  if(sign){const ts=String(Date.now()),nonce=crypto.randomBytes(16).toString('hex'),message=admission.admissionMessage({method:'POST',path:'/v1/runs',bodyHash:admission.sha256Hex(Buffer.from(body)),clientRunId,sessionId,timestamp:ts,nonce,keyId});Object.assign(headers,{'x-samantha-admission':'v1','x-samantha-admission-key':keyId,'x-samantha-admission-ts':ts,'x-samantha-admission-nonce':nonce,'x-samantha-admission-signature':crypto.sign('sha256',Buffer.from(message),pair.privateKey).toString('base64')});}
  return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/runs',method:'POST',headers},res=>{let output='';res.on('data',c=>output+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(output)}))});req.on('error',reject);req.end(body)});
 }
 try{const rogue=await post('ambigu isolated non-owner',false);assert.equal(rogue.status,200);assert.equal(rogue.body.ownerAdmission.owner,false);assert.equal(rogue.body.state,'done');const own=await post('host-probe continuation',true);assert.equal(own.status,200);assert.equal(own.body.ownerAdmission.owner,true);const rows=fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);assert.equal(rows.some(x=>x.mode==='resolve'),false);const parent=JSON.parse(fs.readFileSync(path.join(state,'runs.json'))).runs.find(x=>x.runId===rogue.body.runId);assert.equal(parent.clarificationState,'abandoned');console.log(JSON.stringify({case:'clarify_nonowner_not_resolved_by_owner',ownerAdmission:true,parentState:'abandoned',resolveCalls:0,runId:own.body.runId}));}
 finally{await new Promise(r=>server.close(r));}
};
