// A13 deterministic lifecycle simulations. Not a physical reboot/update acceptance.
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {ClawLiveWarmCore}=require('../dist/companion/clawLiveWarm');
const {VoiceTelemetry}=require('../dist/companion/voiceTelemetry');
const {VoiceTurnProtocol}=require('../dist/companion/voiceTurnProtocol');
class Provider extends EventEmitter{
 static instances=[];static ready=true;
 constructor(){super();this.readyState=0;Provider.instances.push(this);setImmediate(()=>{if(this.readyState===3)return;this.readyState=1;this.emit('open')})}
 send(raw){if(JSON.parse(raw).setup&&Provider.ready)setImmediate(()=>{if(this.readyState!==3)this.emit('message',Buffer.from('{"setupComplete":{}}'))})}
 close(){if(this.readyState===3)return;this.readyState=3;setImmediate(()=>this.emit('close'))}
}
class Local extends EventEmitter{
 constructor(){super();this.readyState=1;this.sent=[]}
 send(raw){this.sent.push(JSON.parse(raw))}
 close(){if(this.readyState===3)return;this.readyState=3;this.emit('close')}
}
const meta=epoch=>({locale:'fr',client:'samantha_android',sessionId:'fixture',protocol:2,sessionEpoch:epoch});
const tick=()=>new Promise(r=>setImmediate(r));
const telemetry=lines=>new VoiceTelemetry({enabled:true,clock:()=>1000000n,wall:()=>1791540000000,append:(_,line)=>lines.push(JSON.parse(line))});
const bundle={token:'fixture-only',setup:{model:'models/fixture'}};
const make=(lines,tokenFactory=async options=>{options.telemetry?.('t02');options.telemetry?.('t03');return bundle})=>new ClawLiveWarmCore({WebSocketImpl:Provider,retryDelay:()=>0,telemetry:telemetry(lines),tokenFactory});
let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name)}
(async()=>{
 await test('detach cancels setup and a new epoch recovers without stale readiness',async()=>{
 const lines=[],core=make(lines),old=new Local();Provider.ready=false;
 try{const attempt=core.attach(old,meta('old'));await tick();await tick();old.close();await attempt;
 Provider.ready=true;const current=new Local();await core.attach(current,meta('new'));
 assert(current.sent.some(v=>v.warmReady?.sessionEpoch==='new'));assert(!old.sent.some(v=>v.warmReady));assert.equal(core.status().clients,1);current.close();
 }finally{Provider.ready=true;core.shutdown()}
 });
 await test('late token callback cannot stamp another session or create a stale socket',async()=>{
 const lines=[];let complete,oldOptions,calls=0;
 const core=make(lines,options=>{calls++;options.telemetry?.('t02');if(calls===1){oldOptions=options;return new Promise(resolve=>complete=resolve)}options.telemetry?.('t03');return Promise.resolve(bundle)});
 const old=new Local();
 try{const attempt=core.attach(old,meta('old-token'));await tick();old.close();await attempt;
 const current=new Local();await core.attach(current,meta('new-token'));const count=Provider.instances.length,before=lines.length;
 oldOptions.telemetry?.('t03');complete(bundle);await tick();await tick();assert.equal(Provider.instances.length,count);assert.equal(lines.length,before);
 assert(lines.filter(e=>e.ev==='t03').every(e=>e.sid==='new-token'));current.close();
 }finally{core.shutdown()}
 });
 await test('process-owner replacement starts cold and keeps sid isolation',async()=>{
 const lines=[],first=make(lines),a=new Local();await first.attach(a,meta('before-restart'));first.shutdown();
 const second=make(lines),b=new Local();try{assert.equal(second.status().providerReady,false);await second.attach(b,meta('after-restart'));
 assert(b.sent.some(v=>v.warmReady?.sessionEpoch==='after-restart'));assert(lines.some(e=>e.sid==='before-restart'));assert(lines.some(e=>e.sid==='after-restart'));b.close();
 }finally{second.shutdown()}
 });
 await test('old provider output cannot cross into recovered owner',async()=>{
 const lines=[],core=make(lines),a=new Local();try{await core.attach(a,meta('first'));const old=Provider.instances.at(-1);a.close();const b=new Local();await core.attach(b,meta('second'));
 const count=b.sent.length;old.emit('message',Buffer.from('{"serverContent":{"turnComplete":true}}'));assert.equal(b.sent.length,count);b.close();
 }finally{core.shutdown()}
 });
 await test('admitted effect survives interruption and close without implicit replay',async()=>{
 let effects=0,finish;const p=new VoiceTurnProtocol(1,'epoch',()=>{},()=>{});
 const ctrl=(kind,body)=>({warmControl:{[kind]:{operationId:kind,sessionEpoch:'epoch',turnId:'a',...body}}});
 p.receive(ctrl('turnStart',{firstSample:0}));p.receive(ctrl('turnEnd',{lastSampleExclusive:0}));p.receive(ctrl('transcriptFinal',{source:'android_speech_service',text:'fixture request'}));
 const action=p.execute('a','fixture request',()=>{effects++;return new Promise(resolve=>finish=resolve)});await Promise.resolve();
 p.receive(ctrl('interrupt',{outputGenerationId:'out-a'}));p.close();finish({state:'completed',fixture:true});assert.deepEqual(await action,{state:'completed',fixture:true});assert.equal(effects,1);
 assert.equal(p.execute('a','fixture request',()=>{effects++;return Promise.resolve({})}),action);assert.equal(effects,1);
 const replacement=new VoiceTurnProtocol(2,'new-epoch',()=>{},()=>{});assert.throws(()=>replacement.execute('a','fixture request',async()=>{effects++}),/not_admissible/);assert.equal(effects,1);
 });
 await test('clock outage leaves Voice ready and reports missing evidence',async()=>{
 const t=new VoiceTelemetry({enabled:true,clock:()=>{throw Error('fixture_clock_unavailable')}});
 const core=new ClawLiveWarmCore({WebSocketImpl:Provider,telemetry:t,retryDelay:()=>0,tokenFactory:async()=>bundle}),a=new Local();
 try{await core.attach(a,meta('clock-outage'));assert(core.status().providerReady);assert(t.status().failed>0);assert.equal(t.status().written,0);a.close();}finally{core.shutdown()}
 });
 console.log(JSON.stringify({passed,failed:0,scope:'M1-A13-simulated-lifecycle-only',physicalReboot:false,physicalUpdate:false,physicalAdb:false}));
})().catch(error=>{console.error(error);process.exitCode=1});
