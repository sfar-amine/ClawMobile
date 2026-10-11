const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'c1-canonical-')),work=path.join(home,'.openclaw/workspace');
const previousHome=os.homedir,previousBin=process.env.CLAWMOBILE_OPENCLAW_BIN;
os.homedir=()=>home;
fs.mkdirSync(path.join(work,'context'),{recursive:true});
fs.writeFileSync(path.join(work,'SOUL.md'),'C1_IDENTITY');fs.writeFileSync(path.join(work,'USER.md'),'C1_PREFERENCES');fs.writeFileSync(path.join(work,'context/HYBRID_CONTEXT.md'),'C1_CONTINUITY');
fs.writeFileSync(path.join(work,'context/OPERATING_RULES.md'),'C1_OPERATING\n'+'rule-prefix\n'.repeat(1300)+'\n## Règles spécialisées\nC1_SPECIALIZED\n### Payments\nHuman confirmation remains mandatory.\n## Unrelated tail\nTAIL_EXCLUDED');
const output=path.join(home,'params.json'),cli=path.join(home,'gateway-fixture.py');
fs.writeFileSync(cli,'#!/usr/bin/env python3\nimport json,sys,time\nfrom pathlib import Path\ntime.sleep(3.2)\np=json.loads(sys.argv[sys.argv.index("--params")+1]);Path('+JSON.stringify(output)+').write_text(json.dumps(p));print(json.dumps({"runId":p["idempotencyKey"],"status":"accepted"}))\n');fs.chmodSync(cli,0o700);process.env.CLAWMOBILE_OPENCLAW_BIN=cli;
// Sanitized real pre-C1 reports: metadata only, never reconstruct private bootstrap content.
const baseline=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/c1/app-bixby-prompt-baseline.json'),'utf8'));
assert.equal(baseline._capture.sanitized,true);
const physicalBefore={};
for(const surface of ['app','bixby']){
 const rows=baseline.sessions.filter(row=>row.surface===surface);
 assert.equal(rows.length,4);
 for(const row of rows){
  assert.equal(row.systemPrompt.projectContextChars,0);
  assert.equal(row.injectedWorkspaceFiles,0);
  assert.equal(row.currentTurn.runtimeContextChars,163);
  assert.ok(Number.isInteger(row.systemPrompt.chars)&&row.systemPrompt.chars>0);
  assert.ok(Number.isInteger(row.tokens.inputTokens)&&row.tokens.inputTokens>0);
  assert.ok(Number.isFinite(row.runtimeMs)&&row.runtimeMs>0);
 }
 const range=select=>[Math.min(...rows.map(select)),Math.max(...rows.map(select))];
 physicalBefore[surface]={sessions:rows.length,systemPromptCharacters:range(r=>r.systemPrompt.chars),inputTokens:range(r=>r.tokens.inputTokens),runtimeMs:range(r=>r.runtimeMs)};
}
const context=require('../dist/companion/clawLive'),client=require('../dist/companion/openclawAgentClient');
(async()=>{
 try{
  let reads=0;const originalRead=fs.openSync;fs.openSync=(...args)=>{reads++;return originalRead(...args)};
  try{assert.equal(context.compactOwnerAgentContext(), '');assert.equal(reads,0);}finally{fs.openSync=originalRead;}
  const extra=context.compactOwnerAgentContext({authority:'owner'});
  for(const marker of ['C1_IDENTITY','C1_PREFERENCES','C1_OPERATING','C1_SPECIALIZED','C1_CONTINUITY'])assert.ok(extra.includes(marker));assert.ok(!extra.includes('TAIL_EXCLUDED'));
  const ownerBegan=performance.now();await client.submitToOpenClawAgent('original message','c1-owner','fixture',{authority:'owner'});const ownerMs=performance.now()-ownerBegan;const params=JSON.parse(fs.readFileSync(output));assert.equal(params.message,'[companion-session:fixture]\noriginal message');assert.equal(params.message.slice(params.message.indexOf('\n')+1),'original message');assert.equal(params.bootstrapContextMode,'lightweight');assert.equal(params.extraSystemPrompt,extra);assert.equal(params.idempotencyKey,'c1-owner');
  const baselineBegan=performance.now();await client.submitToOpenClawAgent('public message','c1-public','fixture');const baselineMs=performance.now()-baselineBegan;assert.ok(ownerMs/baselineMs<1.1);const publicParams=JSON.parse(fs.readFileSync(output));assert.ok(!Object.hasOwn(publicParams,'extraSystemPrompt'));assert.equal(publicParams.message,'[companion-session:fixture]\npublic message');
  await client.submitToOpenClawAgent('/status','c1-slash','fixture',{authority:'owner'});const slashParams=JSON.parse(fs.readFileSync(output));assert.equal(slashParams.message,'/status');assert.equal(slashParams.extraSystemPrompt,extra);assert.equal(slashParams.idempotencyKey,'c1-slash');
  const beforeOversize=fs.readFileSync(output);await assert.rejects(client.submitToOpenClawAgent('x'.repeat(120000),'oversize','fixture',{authority:'owner'}),/canonical_bootstrap_budget_exceeded/);assert.deepEqual(fs.readFileSync(output),beforeOversize);
  // Existing HTTP boundary, private authority independent of caller-supplied flags.
  const intent=require('../dist/companion/intent'),skills=require('../dist/companion/skills');const learning=require('../dist/companion/skillLearning'),skillControl=require('../dist/companion/skillControl');const oldLearn=learning.learnSkill,oldChange=skillControl.changeSkill;const oldIntent=intent.submitIntent,oldSkill=skills.runWorkspaceSkill,oldBrowser=process.env.CLAWMOBILE_COMPANION_ALLOW_BROWSER_ORIGIN;
  let received=null;intent.submitIntent=async(_text,_session,_attachments,options)=>{received=options;return {success:true}};skills.runWorkspaceSkill=async(_id,_body,options)=>{received=options;return {success:true}};
  let nativePrivatePrompt=null;learning.learnSkill=async(_body,_deps,options)=>{received=options;nativePrivatePrompt=context.compactOwnerAgentContext(options);return {state:'accepted'}};skillControl.changeSkill=async(_id,_action,_body,options)=>{received=options;nativePrivatePrompt=context.compactOwnerAgentContext(options);return {state:'accepted'}};
  const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.statusCode=500;res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const request=(url,headers={})=>new Promise((resolve,reject)=>{const body=JSON.stringify({instruction:'Fixture',authority:'owner',caller:'owner'}),req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),...headers}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end(body)});
  try{for(const url of ['/v1/runs','/v1/skills/fixture/run']){assert.equal(await request(url),200);assert.equal(received.authority,'owner');process.env.CLAWMOBILE_COMPANION_ALLOW_BROWSER_ORIGIN='1';for(const headers of [{origin:'https://fixture.invalid'},{referer:'https://fixture.invalid'},{'sec-fetch-site':'same-origin'}]){assert.equal(await request(url,headers),200);assert.equal(received.authority,undefined)}}for(const url of ['/v1/skills/learn','/v1/skills/fixture/try']){nativePrivatePrompt=null;assert.equal(await request(url),403);assert.equal(nativePrivatePrompt,null);assert.ok([200,202].includes(await request(url,{'x-clawmobile-owner-flow':'v1'})));assert.equal(received.authority,'owner');assert.equal(nativePrivatePrompt,extra);for(const headers of [{origin:'https://fixture.invalid'},{referer:'https://fixture.invalid'},{'sec-fetch-site':'same-origin'}]){nativePrivatePrompt=null;assert.equal(await request(url,{'x-clawmobile-owner-flow':'v1',...headers}),403);assert.equal(nativePrivatePrompt,null)}}}
  finally{server.closeAllConnections();await new Promise(r=>server.close(r));intent.submitIntent=oldIntent;skills.runWorkspaceSkill=oldSkill;learning.learnSkill=oldLearn;skillControl.changeSkill=oldChange;if(oldBrowser===undefined)delete process.env.CLAWMOBILE_COMPANION_ALLOW_BROWSER_ORIGIN;else process.env.CLAWMOBILE_COMPANION_ALLOW_BROWSER_ORIGIN=oldBrowser;}
  const crypto=require('node:crypto');let learningOptions;const instruction='Synthetic candidate',confirmationId='12345678-1234-4234-9234-123456789abc';const learningDeps={guard:async()=>{},confirmation:{status:async()=>({state:'approved',intent:{action:{type:'skill.learn',reference:'learn',payloadHash:crypto.createHash('sha256').update(instruction).digest('hex')}}}),consume:async()=>{}},existing:async()=>null,reserve:async()=>({created:true,status:{runId:'fixture-ledger'}}),settle:async()=>{},stored:async()=>null,submit:async(_text,_session,_attachments,options)=>{learningOptions=options;return {accepted:true,runId:'fixture-learning',sessionId:'skill-learning'}}};await oldLearn({instruction,confirmationId,operationId:'c1-learn-owner'},learningDeps,{authority:'owner'});assert.equal(learningOptions.authority,'owner');assert.equal(learningOptions.learningOnly,true);await oldLearn({instruction,confirmationId,operationId:'c1-learn-public'},learningDeps);assert.equal(learningOptions.authority,undefined);
  // Authenticated Bixby socket: untrusted requests cannot trigger any private read.
  const oldSocket=globalThis.WebSocket,oldRelay=process.env.CLAW_VOICE_RELAY_CONFIG;
  const tokenFile=path.join(home,'relay-fixture.token');fs.writeFileSync(tokenFile,'synthetic-relay-token');
  const relayConfig=path.join(home,'.openclaw/voice-relay/config.json');fs.mkdirSync(path.dirname(relayConfig),{recursive:true});fs.writeFileSync(relayConfig,JSON.stringify({url:'wss://fixture.invalid/device',tokenFile}));process.env.CLAW_VOICE_RELAY_CONFIG=relayConfig;
  const sockets=[];class Socket{constructor(){this.readyState=1;this.listeners={};this.sent=[];sockets.push(this)}addEventListener(t,f){(this.listeners[t]??=[]).push(f)}emit(t,event={}){for(const f of this.listeners[t]||[])f(event)}send(v){this.sent.push(JSON.parse(v))}close(){this.readyState=3}}
  globalThis.WebSocket=Socket;
  const bridge=require('../dist/companion/capabilityBridge');const oldBridge=bridge.capabilityBridge;bridge.capabilityBridge=async()=>({selected:{deterministic:false}});
  const originalCall=client.callOpenClawGateway;let bixbyParams=null;client.callOpenClawGateway=async(method,params)=>{assert.equal(method,'agent');bixbyParams=params;return {result:{text:'Synthetic answer'}}};
  const relay=require('../dist/companion/voiceRelay');relay.startVoiceRelay();const socket=sockets[0];socket.emit('message',{data:JSON.stringify({type:'request',requestId:'untrusted',request:'Untrusted message'})});await new Promise(r=>setTimeout(r,20));assert.equal(bixbyParams,null);
  socket.emit('open');socket.emit('message',{data:JSON.stringify({type:'auth_ok'})});socket.emit('message',{data:JSON.stringify({type:'request',requestId:'c1-bixby',request:'Original Bixby message'})});
  for(let i=0;i<100&&!bixbyParams;i++)await new Promise(r=>setTimeout(r,5));assert.ok(bixbyParams);assert.equal(bixbyParams.message,'Original Bixby message');assert.equal(bixbyParams.bootstrapContextMode,'lightweight');assert.equal(bixbyParams.extraSystemPrompt,extra);assert.equal(bixbyParams.idempotencyKey,'c1-bixby');
  relay.stopVoiceRelay();client.callOpenClawGateway=originalCall;bridge.capabilityBridge=oldBridge;globalThis.WebSocket=oldSocket;if(oldRelay===undefined)delete process.env.CLAW_VOICE_RELAY_CONFIG;else process.env.CLAW_VOICE_RELAY_CONFIG=oldRelay;
  const operating=path.join(work,'context/OPERATING_RULES.md');fs.writeFileSync(operating,'# Règles spécialisées\nSPECIAL_ONCE\n');const once=context.compactOwnerAgentContext({authority:'owner'});assert.equal(once.split('SPECIAL_ONCE').length,2);
  fs.writeFileSync(operating,'x'.repeat(11900)+'\n## Règles spécialisées\n'+'Scoped policy\n'.repeat(100)+'END_SPECIALIZED');assert.ok(context.compactOwnerAgentContext({authority:'owner'}).includes('END_SPECIALIZED'));
  fs.writeFileSync(operating,'## Règles spécialisées\n'+'mandatory-policy\n'.repeat(600));assert.throws(()=>context.compactOwnerAgentContext({authority:'owner'}),/canonical_specialized_rules_unavailable/);fs.writeFileSync(operating,'## Règles spécialisées\nRequired complete rule\n');
  const target=path.join(home,'private-fixture.md');fs.writeFileSync(target,'PRIVATE_SYMLINK_MUST_NOT_LOAD');fs.unlinkSync(path.join(work,'USER.md'));fs.symlinkSync(target,path.join(work,'USER.md'));assert.throws(()=>context.compactOwnerAgentContext({authority:'owner'}),/canonical_context_unavailable/);
  fs.unlinkSync(path.join(work,'USER.md'));fs.writeFileSync(path.join(work,'USER.md'),'C1_USER');
  fs.writeFileSync(operating,'a'.repeat(11999)+'😀'+'b'.repeat(50)+'\n## Règles spécialisées\nBOUNDARY_REQUIRED\n');const boundaryPrompt=context.compactOwnerAgentContext({authority:'owner'});assert.ok(boundaryPrompt.includes('BOUNDARY_REQUIRED'));assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(boundaryPrompt));fs.writeFileSync(operating,'## Règles spécialisées\nRequired complete rule\n');
  fs.writeFileSync(operating,'😀'.repeat(5000)+'\n## Règles spécialisées\nMANDATORY_UTF8\n');const multibyteRules=context.compactOwnerAgentContext({authority:'owner'});assert.equal(multibyteRules.split('MANDATORY_UTF8').length,2);fs.writeFileSync(operating,'## Règles spécialisées\nRequired complete rule\n');
  const unicode='مرحبا 😀 '.repeat(10000);for(const file of ['SOUL.md','USER.md','context/HYBRID_CONTEXT.md'])fs.writeFileSync(path.join(work,file),unicode);
  const unicodePrompt=context.compactOwnerAgentContext({authority:'owner'});assert.ok(Buffer.byteLength(unicodePrompt)<65536);assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(unicodePrompt));for(const block of ['IDENTITY','USER','OPERATING_RULES','HYBRID_CONTEXT'])assert.ok(unicodePrompt.includes('## '+block));client.assertCanonicalAgentPayload({message:'مرحبا 😀 '.repeat(500),extraSystemPrompt:unicodePrompt});
  const large=path.join(home,'large.md');fs.writeFileSync(large,'x'.repeat(1000000));assert.ok(context.readCanonical(large,100,{boundedOwner:true}).length<200);
  // Local preparation only: characters/UTF8 bytes estimate, not model billing tokens or S24 latency.
  const samples=[];for(let i=0;i<100;i++){const before=performance.now();context.compactOwnerAgentContext({authority:'owner'});samples.push(performance.now()-before)}samples.sort((a,b)=>a-b);
  console.log(JSON.stringify({test:'C1 boundaries plus real pre-deployment baseline',physicalBefore,physicalAfter:null,comparisonQualified:false,beforeExtraCharacters:0,afterExtraCharacters:extra.length,afterUtf8Bytes:Buffer.byteLength(extra),tokenEstimateBytesDiv4:Math.ceil(Buffer.byteLength(extra)/4),localReadP95Ms:samples[94],syntheticGatewayBaselineMs:baselineMs,syntheticGatewayAfterMs:ownerMs,physicalLatencyAndTokensQualified:false}));
 }finally{os.homedir=previousHome;if(previousBin===undefined)delete process.env.CLAWMOBILE_OPENCLAW_BIN;else process.env.CLAWMOBILE_OPENCLAW_BIN=previousBin;fs.rmSync(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
