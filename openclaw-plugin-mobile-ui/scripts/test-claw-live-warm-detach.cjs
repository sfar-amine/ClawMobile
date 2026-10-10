const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {ClawLiveWarmCore}=require('../dist/companion/clawLiveWarm');
const {VoiceTelemetry}=require('../dist/companion/voiceTelemetry');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const bundle={token:'fixture-only',setup:{model:'models/fixture'}};
class Provider extends EventEmitter{
 static instances=[];static ready=true;
 constructor(){super();this.readyState=0;Provider.instances.push(this);setImmediate(()=>{if(this.readyState===3)return;this.readyState=1;this.emit('open')})}
 send(raw){if(JSON.parse(raw).setup&&Provider.ready)setImmediate(()=>{if(this.readyState!==3)this.emit('message',Buffer.from('{"setupComplete":{}}'))})}
 close(){this.readyState=3;setImmediate(()=>this.emit('close'))}
}
class Local extends EventEmitter{
 constructor(){super();this.readyState=1;this.sent=[]}
 send(raw){this.sent.push(JSON.parse(raw))}
 close(code=1000){if(this.readyState===3)return;this.readyState=3;this.emit('close',code)}
}
const meta=(epoch,protocol=2)=>({locale:'fr',client:'samantha_android',sessionId:'conversation',sessionEpoch:epoch,protocol});
let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name)}
(async()=>{
 await test('clean v2 detach prewarms a fresh unbound generation; next attach uses it',async()=>{
  let calls=0;const lines=[],telemetry=new VoiceTelemetry({enabled:true,clock:()=>1000n,append:(_,line)=>lines.push(JSON.parse(line))});
  const core=new ClawLiveWarmCore({WebSocketImpl:Provider,telemetry,retryDelay:()=>0,tokenFactory:async()=>{calls++;return bundle}}),a=new Local();
  try{
   await core.attach(a,meta('old'));const old=Provider.instances.at(-1),epoch=a.sent.find(v=>v.warmReady).warmReady.connectionEpoch;
   a.close();await tick();await tick();await tick();
   assert.equal(calls,2);assert.equal(old.readyState,3);assert.equal(core.status().providerReady,true);assert.equal(core.status().conversationBound,false);assert.equal(core.status().historyLoaded,false);
   const count=lines.length;const b=new Local();await core.attach(b,meta('new'));assert.equal(calls,2);assert(b.sent.some(v=>v.warmReady?.sessionEpoch==='new'));assert(b.sent.find(v=>v.warmReady).warmReady.connectionEpoch>epoch);
   assert.deepEqual(lines.slice(count).map(e=>[e.sid,e.turn,e.ev]),[['new',0,'t01'],['new',0,'t07']]);
   const messages=b.sent.length;old.emit('message',Buffer.from('{"serverContent":{"turnComplete":true}}'));assert.equal(b.sent.length,messages);
   b.close(1001);
  }finally{core.shutdown()}
 });
 await test('immediate next attach shares pending prewarm instead of minting another token',async()=>{
  let calls=0,finish;const core=new ClawLiveWarmCore({WebSocketImpl:Provider,retryDelay:()=>0,tokenFactory:()=>{calls++;return calls===2?new Promise(r=>finish=r):Promise.resolve(bundle)}}),a=new Local();
  try{await core.attach(a,meta('first'));a.close();const b=new Local(),attached=core.attach(b,meta('second'));assert.equal(calls,2);finish(bundle);await attached;assert(b.sent.some(v=>v.warmReady?.sessionEpoch==='second'));assert.equal(calls,2);b.close(1001);}finally{core.shutdown()}
 });
 await test('abnormal detach resets cold without automatic prewarm',async()=>{
  let calls=0;const core=new ClawLiveWarmCore({WebSocketImpl:Provider,tokenFactory:async()=>{calls++;return bundle}}),a=new Local();
  try{await core.attach(a,meta('error'));a.close(1006);await tick();assert.equal(calls,1);assert.equal(core.status().state,'cold');}finally{core.shutdown()}
 });
 await test('detach during setup stays cancelled without a replacement connection',async()=>{
  let calls=0;Provider.ready=false;const core=new ClawLiveWarmCore({WebSocketImpl:Provider,tokenFactory:async()=>{calls++;return bundle}}),a=new Local();
  try{const attached=core.attach(a,meta('setup'));await tick();a.close();await attached;await tick();assert.equal(calls,1);assert.equal(core.status().state,'cold');}finally{Provider.ready=true;core.shutdown()}
 });
 await test('shutdown never starts a prewarm even with a normal local close',async()=>{
  let calls=0;const core=new ClawLiveWarmCore({WebSocketImpl:Provider,tokenFactory:async()=>{calls++;return bundle}}),a=new Local();
  try{await core.attach(a,meta('shutdown'));core.shutdown();await tick();assert.equal(calls,1);assert.equal(core.status().state,'cold');}finally{core.shutdown()}
 });
 await test('legacy detach keeps its existing warm provider',async()=>{
  let calls=0;const core=new ClawLiveWarmCore({WebSocketImpl:Provider,tokenFactory:async()=>{calls++;return bundle}}),a=new Local();
  try{await core.attach(a,meta('legacy',1));const provider=Provider.instances.at(-1);a.close();await tick();assert.equal(calls,1);assert.equal(provider.readyState,1);assert.equal(core.status().providerReady,true);}finally{core.shutdown()}
 });
 await test('prewarm failure consumes only the existing bounded retry budget',async()=>{
  let calls=0;const core=new ClawLiveWarmCore({WebSocketImpl:Provider,retryDelay:()=>0,tokenFactory:async()=>{if(++calls>1)throw Error('fixture');return bundle}}),a=new Local();
  try{await core.attach(a,meta('failure'));a.close();await tick();await tick();assert.equal(calls,4);assert.equal(core.status().providerReady,false);assert.equal(core.status().state,'error');}finally{core.shutdown()}
 });
 console.log(JSON.stringify({passed,failed:0,scope:'clean-detach-fixtures-not-S24',liveLatencyMeasured:false}));
})().catch(error=>{console.error(error);process.exitCode=1});
