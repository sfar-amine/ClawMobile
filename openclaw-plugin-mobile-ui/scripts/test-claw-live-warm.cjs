const assert=require("assert");
const {EventEmitter}=require("events");
const {ClawLiveWarmCore}=require("../dist/companion/clawLiveWarm.js");

class FakeProvider extends EventEmitter {
  static OPEN=1;
  static instances=[];
  constructor(url){
    super();this.url=url;this.readyState=0;this.sent=[];FakeProvider.instances.push(this);
    setTimeout(()=>{this.readyState=1;this.emit("open")},1);
  }
  send(raw){
    this.sent.push(String(raw));
    const v=JSON.parse(String(raw));
    if(v.setup){
      this.setup=v.setup;
      setTimeout(()=>{
        this.emit("message",Buffer.from(JSON.stringify({setupComplete:{}})));
        this.emit("message",Buffer.from(JSON.stringify({sessionResumptionUpdate:{resumable:true,newHandle:"resume-1"}})));
      },1);
    }
    return true;
  }
  close(){const was=this.readyState;this.readyState=3;if(was!==3)setTimeout(()=>this.emit("close"),0)}
}
class FakeLocal extends EventEmitter {
  static OPEN=1;
  constructor(){super();this.readyState=1;this.sent=[]}
  send(v){this.sent.push(String(v));return true}
  close(){this.readyState=3;this.emit("close")}
}
const tokenFactory=async()=>({token:"ephemeral",setup:{model:"models/gemini-3.8-live",generationConfig:{responseModalities:["AUDIO"]}}});
const wait=(ms=8)=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  const core=new ClawLiveWarmCore({tokenFactory,WebSocketImpl:FakeProvider,idleMs:60000});
  const meta={locale:"fr",client:"samantha_android",sessionId:"session-a"};
  const st=await core.prewarm(meta);
  assert.equal(st.state,"warm");
  assert.equal(st.providerReady,true);
  assert.equal(FakeProvider.instances.length,1);
  assert.deepEqual(FakeProvider.instances[0].setup.contextWindowCompression,{slidingWindow:{}});
  assert.deepEqual(FakeProvider.instances[0].setup.sessionResumption,{});
  await wait();
  assert.equal(core.status().resumable,true);

  const local=new FakeLocal();
  await core.attach(local,meta);
  const ready=local.sent.map(JSON.parse).find(x=>x.warmReady)?.warmReady;
  assert.ok(ready);
  assert.equal(ready.historyRequired,true);
  local.emit("message",Buffer.from(JSON.stringify({warmControl:{historyLoaded:true}})));
  assert.equal(core.status().historyLoaded,true);
  local.close();
  assert.equal(core.status().providerReady,true);

  const local2=new FakeLocal();
  await core.attach(local2,meta);
  const ready2=local2.sent.map(JSON.parse).find(x=>x.warmReady)?.warmReady;
  assert.equal(ready2.historyRequired,false);

  await core.prewarm({...meta,sessionId:"session-b"});
  assert.equal(FakeProvider.instances.length,2);
  assert.equal(core.status().historyLoaded,false);
  core.shutdown();
  console.log(JSON.stringify({ok:true,warm:true,compression:true,resumption:true,historyGate:true,conversationReset:true}));
})().catch(e=>{console.error(e);process.exit(1)});
