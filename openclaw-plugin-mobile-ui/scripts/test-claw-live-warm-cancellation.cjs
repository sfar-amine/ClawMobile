const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {ClawLiveWarmCore} = require('../dist/companion/clawLiveWarm.js');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const bundle = {token:'fixture-only',setup:{model:'models/fixture'}};
class Provider extends EventEmitter {
  static OPEN = 1;
  static instances = [];
  static autoReady = false;
  constructor() {
    super(); this.readyState=0; Provider.instances.push(this);
    setTimeout(() => {if(this.readyState===3)return;this.readyState=1;this.emit('open')},1);
  }
  send(raw) {
    if(JSON.parse(String(raw)).setup && Provider.autoReady)
      setTimeout(() => this.emit('message',Buffer.from('{"setupComplete":{}}')),1);
  }
  close() {this.readyState=3;setTimeout(()=>this.emit('close'),0)}
}
async function settled(promise) {
  return Promise.race([promise.then(()=> 'resolved',()=> 'rejected'),wait(120).then(()=> 'pending')]);
}
async function main() {
  const meta={locale:'fr',client:'samantha_android',sessionId:'cancel-test-a'};
  const core=new ClawLiveWarmCore({tokenFactory:async()=>bundle,WebSocketImpl:Provider,retryDelay:()=>0});
  const first=core.prewarm(meta); first.catch(()=>{});
  await wait(10);assert.equal(core.status().stage,'setup');
  core.cool('test-cancel');
  assert.equal(await settled(first),'rejected','Reset during setup must settle the original waiter');
  Provider.autoReady=true;
  const second=await core.prewarm({...meta,sessionId:'cancel-test-b'});
  assert.equal(second.providerReady,true,'The next prewarm must not inherit a cancelled promise');
  core.shutdown();

  let deliverToken;
  const pendingToken=new Promise(resolve=>{deliverToken=resolve});
  const tokenCore=new ClawLiveWarmCore({tokenFactory:()=>pendingToken,WebSocketImpl:Provider,retryDelay:()=>0});
  const tokenAttempt=tokenCore.prewarm(meta);tokenAttempt.catch(()=>{});await wait(2);
  tokenCore.cool('test-token-cancel');
  assert.equal(await settled(tokenAttempt),'rejected','Reset must also cancel token wait');
  const socketCount=Provider.instances.length;deliverToken(bundle);await wait(10);
  assert.equal(Provider.instances.length,socketCount,'Cancelled token must not create a stale socket');
  assert.equal(tokenCore.status().state,'cold');tokenCore.shutdown();

  const switchCore=new ClawLiveWarmCore({tokenFactory:async()=>bundle,WebSocketImpl:Provider,retryDelay:()=>0});
  Provider.autoReady=false;
  const old=switchCore.prewarm(meta);old.catch(()=>{});await wait(10);
  Provider.autoReady=true;
  const newer=await switchCore.prewarm({...meta,sessionId:'cancel-test-c'});
  assert.equal(await settled(old),'rejected');assert.equal(newer.providerReady,true);
  assert.equal(switchCore.status().conversationBound,true);switchCore.shutdown();
  console.log(JSON.stringify({ok:true,setupCancellation:true,tokenCancellation:true,noStaleSocket:true,conversationSwitch:true,subsequentPrewarm:true}));
}
main().catch(error=>{console.error(error);process.exitCode=1});
