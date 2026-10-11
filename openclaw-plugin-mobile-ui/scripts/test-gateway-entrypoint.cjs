/** Synthetic SDK boundary around the real entrypoint; payload/CLI latency are actual S24 captures. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Module=require('node:module');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-entrypoint-'));
// Synthetic canonical bootstrap for the submit wrapper; this is not an S24 capture.
const previousHome=os.homedir,previousBin=process.env.CLAWMOBILE_OPENCLAW_BIN;
os.homedir=()=>root;
const workspace=path.join(root,'.openclaw','workspace');
fs.mkdirSync(path.join(workspace,'context'),{recursive:true});
fs.writeFileSync(path.join(workspace,'SOUL.md'),'Synthetic identity fixture.\n');
fs.writeFileSync(path.join(workspace,'USER.md'),'Synthetic owner context.\n');
fs.writeFileSync(path.join(workspace,'context','OPERATING_RULES.md'),'## Règles spécialisées\nHuman approval remains required.\n');
fs.writeFileSync(path.join(workspace,'context','HYBRID_CONTEXT.md'),'Synthetic bounded continuity.\n');
const pkg=path.join(root,'node_modules/openclaw');fs.mkdirSync(pkg,{recursive:true});
fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'openclaw',version:'2026.9.6',type:'module',exports:{'./plugin-sdk/gateway-runtime':'./gateway.mjs','./plugin-sdk/config-runtime':'./config.mjs','./plugin-sdk/gateway-config-runtime':'./ports.mjs','./plugin-sdk/secret-ref-runtime':'./secrets.mjs'}}));
fs.writeFileSync(path.join(pkg,'config.mjs'),'export function loadConfig(){return {gateway:{mode:"local",auth:{mode:"none"}}};} export function coerceSecretRef(){return null;}');
fs.writeFileSync(path.join(pkg,'secrets.mjs'),'export async function resolveSecretRefValues(){return new Map();}');
fs.writeFileSync(path.join(pkg,'ports.mjs'),'export function resolveGatewayPort(){return 18789;}');
fs.writeFileSync(path.join(pkg,'gateway.mjs'),`
export function resolveGatewayAuth(){return {mode:'none',allowTailscale:false};}
export class GatewayClient {
 constructor(options){this.options=options;this.connected=false;const s=globalThis.gatewayEntryFixture;s.instances++;s.options=options;}
 start(){this.connected=true;this.hello=setTimeout(()=>this.options.onHelloOk({}),30);}
 stop(){clearTimeout(this.hello);this.connected=false;globalThis.gatewayEntryFixture.stops++;this.options.onClose(1000);}
 async stopAndWait(){this.stop();}
 async request(method,params,options){
  const s=globalThis.gatewayEntryFixture;s.calls++;s.active++;s.max=Math.max(s.max,s.active);s.last={method,params,options};
  try{await new Promise(resolve=>setTimeout(resolve,25));
   if(s.failure)throw Object.assign(new Error(s.failure.message),s.failure);
   return s.fixture.response;
  }finally{s.active--;}
 }
}
`);
process.env.NODE_PATH=path.join(root,'node_modules');Module.Module._initPaths();
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/gateway/models.list.json'),'utf8'));
globalThis.gatewayEntryFixture={fixture,instances:0,stops:0,calls:0,active:0,max:0};
const handshake=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/p0-1/gateway-handshake.json'),'utf8'));
const capturedConnect=handshake.frames.find(x=>x.frame.method==='connect').frame.params;
const api=require('../dist/companion/openclawAgentClient');
(async()=>{
 const s=globalThis.gatewayEntryFixture;
 // Canonical host turns must never initialize or borrow the shared admin connection.
 const turnCli=path.join(root,'turn-cli'),turnLog=path.join(root,'turn-cli.jsonl');
 fs.writeFileSync(turnCli,'#!/usr/bin/env node\nconst fs=require("node:fs");fs.appendFileSync('+JSON.stringify(turnLog)+',JSON.stringify(process.argv.slice(2))+"\\n");process.stdout.write(JSON.stringify({runId:"fixture-run",status:"accepted"}));\n');fs.chmodSync(turnCli,0o700);
 process.env.CLAWMOBILE_OPENCLAW_BIN=turnCli;
 const originalTurn={sessionKey:'agent:main:companion-fixture',idempotencyKey:'fixture-run',message:'quelle heure est-il ?'};
 await api.callOpenClawGateway('agent',originalTurn,{expectFinal:true,timeoutMs:1000});
 await api.callOpenClawGateway('chat.send',{...originalTurn,message:'fixture chat'},{timeoutMs:750});
 await api.callOpenClawGateway('agent',{...originalTurn,message:'/reset'},{timeoutMs:600});
 assert.equal(s.instances,0);assert.equal(s.calls,0);
 let turnCalls=fs.readFileSync(turnLog,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(turnCalls.length,3);
 assert.deepEqual(turnCalls[0],['gateway','call','agent','--expect-final','--json','--timeout','1000','--params',JSON.stringify(originalTurn)]);
 assert.deepEqual(turnCalls[1],['gateway','call','chat.send','--json','--timeout','750','--params',JSON.stringify({...originalTurn,message:'fixture chat'})]);
 assert.deepEqual(turnCalls[2],['gateway','call','agent','--json','--timeout','600','--params',JSON.stringify({...originalTurn,message:'/reset'})]);
 const began=Date.now();
 const results=await Promise.all(Array.from({length:8},()=>api.callOpenClawGateway('models.list',{}, {timeoutMs:1000})));
 assert.ok(results.every(x=>JSON.stringify(x)===JSON.stringify(fixture.response)));
 assert.equal(s.instances,1);assert.equal(s.calls,8);assert.equal(s.max,4);
 assert.ok(Date.now()-began<1000);assert.equal(s.options.deviceIdentity,null);
 assert.equal(s.options.role,capturedConnect.role);assert.equal(s.options.mode,capturedConnect.client.mode);assert.equal(s.options.clientName,capturedConnect.client.id);assert.equal(s.options.minProtocol,capturedConnect.minProtocol);assert.equal(s.options.maxProtocol,capturedConnect.maxProtocol);assert.equal(capturedConnect.device,undefined);assert.deepEqual(s.options.caps,capturedConnect.caps);
 assert.ok(!s.options.scopes.includes('operator.talk.secrets'));
 assert.ok(!s.options.scopes.includes('operator.pairing'));
 const wsCallsBeforeTurns=s.calls;
 await api.callOpenClawGateway('agent',{idempotencyKey:'fixture-run',message:'/status'}, {expectFinal:true,timeoutMs:1000});
 await api.callOpenClawGateway('chat.send',{...originalTurn,message:'fixture concurrent chat'},{timeoutMs:1000});
 // Existing admin RPC activity cannot grant owner to a later turn; owner prompt options cannot change dispatch.
 process.env.CLAWMOBILE_GATEWAY_TURN_WS='true';
 await api.submitToOpenClawAgent('fixture ordinary turn','fixture-run','fixture-session',{authority:'owner'});
 delete process.env.CLAWMOBILE_GATEWAY_TURN_WS;
 assert.equal(s.calls,wsCallsBeforeTurns);assert.equal(s.instances,1);
 turnCalls=fs.readFileSync(turnLog,'utf8').trim().split('\n').map(JSON.parse);assert.equal(turnCalls.length,6);
 assert.equal(turnCalls[3][2],'agent');assert.ok(turnCalls[3].includes('--expect-final'));
 assert.equal(turnCalls[4][2],'chat.send');assert.equal(turnCalls[5][2],'agent');
 const submitted=JSON.parse(turnCalls[5][turnCalls[5].indexOf('--params')+1]);assert.equal(submitted.idempotencyKey,'fixture-run');
 assert.ok(!turnCalls.some(args=>args.includes('--token')||args.includes('--password')||args.includes('--scopes')));

 s.failure={name:'GatewayClientRequestError',gatewayCode:'INVALID_REQUEST',message:'config changed since last load; re-run config.get and retry',details:{private:'owner@example.invalid'}};
 await assert.rejects(api.callOpenClawGateway('config.patch',{baseHash:'fixture'}, {timeoutMs:1000}),e=>e.code==='gateway_config_revision_conflict'&&e.effectNotStarted&&!e.details&&e.message==='config baseHash conflict');
 s.failure={name:'Error',message:'private token fixture owner@example.invalid'};const calls=s.calls;
 await assert.rejects(api.callOpenClawGateway('cron.run',{id:'fixture'}, {timeoutMs:1000}),e=>e.code==='gateway_dispatch_indeterminate'&&e.requestSent&&e.message==='gateway_dispatch_indeterminate');
 assert.equal(s.calls,calls+1);assert.equal(s.instances,1);
 api.closeOpenClawGateway();assert.equal(s.stops,1);
 const cli=path.join(root,'fallback-cli');
 fs.writeFileSync(cli, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:false,error:{type:"gateway_request_error",code:"INVALID_REQUEST",message:"config changed since last load; re-run config.get and retry",retryable:false}}));process.exit(1);\n');fs.chmodSync(cli,0o700);
 const child=require('node:child_process').spawnSync(process.execPath,['-e',`
  const assert=require('node:assert/strict');const api=require(${JSON.stringify(path.resolve(__dirname,'../dist/companion/openclawAgentClient'))});
  api.callOpenClawGateway('config.patch',{baseHash:'fixture'},{timeoutMs:1000}).then(()=>process.exitCode=1,e=>{
   assert.equal(e.code,'gateway_config_revision_conflict');assert.equal(e.message,'config baseHash conflict');assert.equal(e.effectNotStarted,true);api.closeOpenClawGateway();
  }).catch(()=>process.exitCode=1);
 `],{env:{...process.env,NODE_PATH:'',CLAWMOBILE_OPENCLAW_BIN:cli},encoding:'utf8',timeout:3000});
 assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'');

 // Real captured CLI refusal keeps the same public unknown-job classification as SDK.
 const cronRefusal=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/r22/cron.runs.unknown-id.json'),'utf8'));
 fs.writeFileSync(cli,'#!/usr/bin/env node\nprocess.stdout.write('+JSON.stringify(JSON.stringify(cronRefusal.response))+');process.exit(1);\n');
 const cronChild=require('node:child_process').spawnSync(process.execPath,['-e',`
  const assert=require('node:assert/strict');const api=require(${JSON.stringify(path.resolve(__dirname,'../dist/companion/openclawAgentClient'))});
  api.callOpenClawGateway('cron.runs',${JSON.stringify(cronRefusal._capture.params)},{timeoutMs:1000}).then(()=>process.exitCode=1,e=>{
   assert.equal(e.code,'CRON_JOB_NOT_FOUND');assert.equal(e.effectNotStarted,true);assert.equal(e.message,'CRON_JOB_NOT_FOUND');assert.equal(e.details,undefined);api.closeOpenClawGateway();
  }).catch(()=>process.exitCode=1);
 `],{env:{...process.env,NODE_PATH:'',CLAWMOBILE_OPENCLAW_BIN:cli},encoding:'utf8',timeout:3000});
 assert.equal(cronChild.status,0,cronChild.stderr);assert.equal(cronChild.stdout,'');
 console.log('Captured S24 owner timing: CLI models.list '+fixture._capture.latencyMs+'ms; handshake owner import/connect/health '+handshake._capture.latencyMs+'ms; operations differ, no production wiring comparison claimed.');
 console.log('P0-1 real callOpenClawGateway entrypoint: shared official SDK owner, hello gate, four RPCs, control RPC unchanged params/expectFinal, host turns CLI only, reduced control scopes, CAS refusal, no replay, shutdown; SDK boundary synthetic, S24 payload real.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{api.closeOpenClawGateway();os.homedir=previousHome;if(previousBin===undefined)delete process.env.CLAWMOBILE_OPENCLAW_BIN;else process.env.CLAWMOBILE_OPENCLAW_BIN=previousBin;fs.rmSync(root,{recursive:true,force:true});delete globalThis.gatewayEntryFixture;});
