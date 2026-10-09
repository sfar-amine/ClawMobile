// A11: real loopback HTTP/WS transport, fixture dependencies only. No providers or S24.
const assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const WebSocket=require('ws');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-m1-contracts-'));
os.homedir=()=>root;
process.env.OPENCLAW_STATE_DIR=path.join(root,'state');
const index=path.join(process.env.OPENCLAW_STATE_DIR,'agents/main/sessions');fs.mkdirSync(index,{recursive:true});fs.writeFileSync(path.join(index,'sessions.json'),'{"sessions":[]}');
const gateway=require('../dist/companion/openclawGatewayClient');
gateway.getGatewayStatus=async()=>({reachable:true,host:'127.0.0.1',port:18789,message:'fixture'});
const android=require('../dist/tools/android');android.android_health=async()=>({ok:true,capabilities:{adb:true}});
const controlRoot=path.join(root,'playbooks');fs.mkdirSync(path.join(controlRoot,'reporting'),{recursive:true});
fs.writeFileSync(path.join(controlRoot,'reporting/control_snapshot.py'),'import json\nprint(json.dumps({"schemaVersion":2,"sections":{"health":{"schemaVersion":2,"resourceKey":"control/v2/health","dataRevision":"a"*64,"availability":"ready","freshness":"fresh","remainingFreshMs":1000,"data":{"status":"fixture"}}}}))\n');
process.env.SAMANTHA_CONTROL_PLAYBOOKS=controlRoot;
const {route}=require('../dist/companion/server');
const {reserveSubmittedRun}=require('../dist/companion/runs');
const {VoiceTelemetry}=require('../dist/companion/voiceTelemetry');
const {ClawLiveWarmCore,attachClawLiveWarmUpgrade}=require('../dist/companion/clawLiveWarm');
class Provider extends EventEmitter {
 static instances=[];
 constructor(){super();this.readyState=0;this.sent=[];Provider.instances.push(this);setImmediate(()=>{if(this.readyState===3)return;this.readyState=1;this.emit('open')});}
 send(raw){const v=JSON.parse(raw);this.sent.push(v);if(v.setup)setImmediate(()=>this.emit('message',Buffer.from('{"setupComplete":{}}')));}
 close(){this.readyState=3;setImmediate(()=>this.emit('close'));}
}
const lines=[];
const telemetry=new VoiceTelemetry({enabled:true,clock:()=>123456789n,wall:()=>1791540000000,append:(_,line)=>lines.push(JSON.parse(line))});
const core=new ClawLiveWarmCore({WebSocketImpl:Provider,telemetry,retryDelay:()=>0,tokenFactory:async options=>{options.telemetry?.('t02');options.telemetry?.('t03');return {token:'fixture-only',setup:{model:'models/fixture'}}}});
let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name)}
function request(port,url,headers={}){return new Promise((resolve,reject)=>{const r=http.get({host:'127.0.0.1',port,path:url,headers},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:text?JSON.parse(text):null}));});r.setTimeout(2000,()=>r.destroy(Error('test_timeout')));r.on('error',reject);});}
function message(ws,predicate){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clean();reject(Error('fixture_message_timeout'))},2000);function clean(){clearTimeout(timer);ws.off('message',receive)}function receive(raw){const v=JSON.parse(raw);if(predicate(v)){clean();resolve(v)}}ws.on('message',receive)});}
(async()=>{
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));attachClawLiveWarmUpgrade(server,core);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;let ws;
 try{
 await test('C4 health shape preserves runtime/gateway/checks',async()=>{const r=await request(port,'/v1/health');assert.equal(r.status,200);assert.equal(r.data.version,'0.1.0');assert(Array.isArray(r.data.checks));assert.equal(r.data.gateway.reachable,true);});
 await test('C4 capabilities shape is stable',async()=>{const r=await request(port,'/v1/capabilities');assert.equal(r.status,200);assert.equal(r.data.runtime,'termux-openclaw');assert.equal(r.data.features.tasks,'available');});
 await test('C4 skills and runs lists are arrays',async()=>{for(const [url,key] of [['/v1/skills','skills'],['/v1/runs','runs']]){const r=await request(port,url);assert.equal(r.status,200);assert(Array.isArray(r.data[key]));}});
 await test('C4 by-client read finds the same reserved run and unknown is 404',async()=>{
 const client='samantha-m1-fixture';const created=await reserveSubmittedRun('fixture-only','session-fixture',client,{userText:'fixture-only',requestText:'fixture-only',attachments:[]});
 for(const url of ['/v1/runs/by-client/'+client,'/v1/runs/'+created.status.runId]){const r=await request(port,url);assert.equal(r.status,200);assert.equal(r.data.runId,created.status.runId);assert.equal(r.data.clientRunId,client);}
 const missing=await request(port,'/v1/runs/by-client/not-present');assert.equal(missing.status,404);assert.equal(missing.data.state,'unknown');assert.equal(missing.headers['cache-control'],'no-store');
 });
 await test('C4 Control v2 facade preserves section envelope',async()=>{const r=await request(port,'/v1/extensions/samantha-control/health?contract=2');assert.equal(r.status,200);assert.equal(r.data.schemaVersion,2);assert.equal(r.data.sections.health.resourceKey,'control/v2/health');assert.equal(r.headers['cache-control'],'no-store');});
 await test('C4 browser origins cannot read sensitive endpoints',async()=>{for(const url of ['/v1/runs','/v1/skills','/v1/extensions/samantha-control/health?contract=2'])assert.equal((await request(port,url,{Origin:'https://untrusted.invalid'})).status,403);});
 await test('Warm v2 HTTP upgrade emits warmReady and cold-stage C1',async()=>{
 ws=new WebSocket(`ws://127.0.0.1:${port}/v1/extensions/claw-live/socket?protocol=2&session=fixture&epoch=epoch-fixture`);
 const r=await message(ws,v=>v.warmReady);assert.equal(r.warmReady.protocolVersion,2);assert.equal(r.warmReady.sessionEpoch,'epoch-fixture');assert(Number.isInteger(r.warmReady.connectionEpoch));
 assert.deepEqual(lines.map(e=>e.ev),['t01','t02','t03','t04','t05','t06','t07']);assert(lines.every(e=>e.sid==='epoch-fixture'&&e.turn===0));
 });
 await test('warmControl reaches protocol once; audio and interruption correlate to turn 1',async()=>{
 let ack=message(ws,v=>v.warmAck?.operationId==='start');ws.send(JSON.stringify({warmControl:{turnStart:{operationId:'start',sessionEpoch:'epoch-fixture',turnId:'voice-1',firstSample:0}}}));await ack;
 ack=message(ws,v=>v.warmAck?.operationId==='end');ws.send(JSON.stringify({warmControl:{turnEnd:{operationId:'end',sessionEpoch:'epoch-fixture',turnId:'voice-1',lastSampleExclusive:0}}}));await ack;
 const provider=Provider.instances.at(-1);provider.emit('message',Buffer.from('{"serverContent":{"modelTurn":{"parts":[{"inlineData":{"mimeType":"audio/pcm","data":"AA=="}}]}}}'));
 provider.emit('message',Buffer.from('{"serverContent":{"interrupted":true}}'));
 await new Promise(r=>setImmediate(r));assert.deepEqual(lines.slice(-3).map(e=>[e.ev,e.turn]),[['t25p',1],['t30p',1],['t44',1]]);
 assert(!JSON.stringify(lines).includes('AA=='));assert(!JSON.stringify(lines).includes('fixture-only'));
 });
 await test('provider endpointing is explicitly refused, never silently treated as Silero',async()=>{
 const count=Provider.instances.length;const rejected=new WebSocket(`ws://127.0.0.1:${port}/v1/extensions/claw-live/socket?protocol=2&epoch=provider-epoch&endpointing=provider`);
 const error=await message(rejected,v=>v.warmError);assert.equal(error.warmError.code,'endpointing_not_supported');assert.equal(error.warmError.stage,'protocol');
 assert.equal(Provider.instances.length,count);
 });
 await test('invalid epoch is rejected at the real WS boundary',async()=>{const bad=new WebSocket(`ws://127.0.0.1:${port}/v1/extensions/claw-live/socket?protocol=2&epoch=bad%20epoch`);await new Promise((resolve,reject)=>{bad.on('close',code=>{try{assert.equal(code,1008);resolve()}catch(e){reject(e)}});bad.on('error',reject)});});
 }finally{if(ws)ws.terminate();core.shutdown();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
 await test('Warm error envelope on token failure retains legacy contract',async()=>{
 class Local extends EventEmitter{constructor(){super();this.readyState=1;this.sent=[]}send(raw){this.sent.push(JSON.parse(raw))}close(){this.readyState=3;this.emit('close')}}
 const fail=new ClawLiveWarmCore({WebSocketImpl:Provider,retryDelay:()=>0,tokenFactory:async()=>{throw Error('fixture_token_failure')}});const client=new Local();try{await fail.attach(client,{locale:'fr',client:'samantha_android',sessionId:'fail',protocol:2,sessionEpoch:'fail-epoch'});const e=client.sent.find(v=>v.warmError);assert(e);assert.equal(e.warmError.stage,'token');assert.equal(typeof e.warmError.code,'string');}finally{client.close();fail.shutdown()}
 });
 console.log(JSON.stringify({passed,failed:0,scope:'M1-A11-local-fixture-HTTP-WS',notLiveS24:true}));
})().catch(e=>{console.error(e);process.exitCode=1});
