/** Synthetic SDK boundary around the real entrypoint; payload/CLI latency are actual S24 captures. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Module=require('node:module');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-entrypoint-'));
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
 const s=globalThis.gatewayEntryFixture,began=Date.now();
 const results=await Promise.all(Array.from({length:8},()=>api.callOpenClawGateway('models.list',{}, {timeoutMs:1000})));
 assert.ok(results.every(x=>JSON.stringify(x)===JSON.stringify(fixture.response)));
 assert.equal(s.instances,1);assert.equal(s.calls,8);assert.equal(s.max,4);
 assert.ok(Date.now()-began<1000);assert.equal(s.options.deviceIdentity,null);
 assert.equal(s.options.role,capturedConnect.role);assert.equal(s.options.mode,capturedConnect.client.mode);assert.equal(s.options.clientName,capturedConnect.client.id);assert.equal(s.options.minProtocol,capturedConnect.minProtocol);assert.equal(s.options.maxProtocol,capturedConnect.maxProtocol);assert.equal(capturedConnect.device,undefined);assert.deepEqual(s.options.caps,capturedConnect.caps);
 assert.ok(!s.options.scopes.includes('operator.talk.secrets'));
 assert.ok(!s.options.scopes.includes('operator.pairing'));
 await api.callOpenClawGateway('agent',{idempotencyKey:'fixture-run',message:'/status'}, {expectFinal:true,timeoutMs:1000});
 assert.equal(s.last.options.expectFinal,true);assert.deepEqual(s.last.params,{idempotencyKey:'fixture-run',message:'/status'});
 s.failure={name:'GatewayClientRequestError',gatewayCode:'INVALID_REQUEST',message:'config changed since last load; re-run config.get and retry',details:{private:'owner@example.invalid'}};
 await assert.rejects(api.callOpenClawGateway('config.patch',{baseHash:'fixture'}, {timeoutMs:1000}),e=>e.code==='gateway_config_revision_conflict'&&e.effectNotStarted&&!e.details&&e.message==='config baseHash conflict');
 s.failure={name:'Error',message:'private token fixture owner@example.invalid'};const calls=s.calls;
 await assert.rejects(api.callOpenClawGateway('cron.run',{id:'fixture'}, {timeoutMs:1000}),e=>e.code==='gateway_dispatch_indeterminate'&&e.requestSent&&e.message==='gateway_dispatch_indeterminate');
 assert.equal(s.calls,calls+1);assert.equal(s.instances,1);
 api.closeOpenClawGateway();assert.equal(s.stops,1);
 console.log('Captured S24 owner timing: CLI models.list '+fixture._capture.latencyMs+'ms; handshake owner import/connect/health '+handshake._capture.latencyMs+'ms; operations differ, no production wiring comparison claimed.');
 console.log('P0-1 real callOpenClawGateway entrypoint: shared official SDK owner, hello gate, four RPCs, unchanged params/expectFinal, reduced scopes, CAS refusal, no replay, shutdown; SDK boundary synthetic, S24 payload real.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{api.closeOpenClawGateway();fs.rmSync(root,{recursive:true,force:true});delete globalThis.gatewayEntryFixture;});
