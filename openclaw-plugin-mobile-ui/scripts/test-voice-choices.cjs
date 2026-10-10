const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {EventEmitter}=require('node:events');
(async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'voice-choice-'));
 const live=require('../dist/companion/clawLive');
 const {ClawLiveWarmCore,clawLiveWarmMeta,attachClawLiveWarmUpgrade,clawLiveWarmCore}=require('../dist/companion/clawLiveWarm');
 let minted=0;const fakeFetch=async()=>{minted++;return {ok:true,status:200,json:async()=>({name:'test-ephemeral'})};};
 const realToken=live.createClawLiveToken;
 live.createClawLiveToken=(_fetch,_key,options)=>realToken(fakeFetch,async()=>'test-private', {...options,home});
 const {route}=require('../dist/companion/server');
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.statusCode=500;res.end('{}');}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(url,method='GET',body,headers={})=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers:{'content-type':'application/json',...headers}},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw||'{}')}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
 class Provider extends EventEmitter{static OPEN=1;static instances=[];constructor(){super();this.readyState=0;this.sent=[];Provider.instances.push(this);setImmediate(()=>{this.readyState=1;this.emit('open');});}send(raw){const v=JSON.parse(raw);this.sent.push(v);if(v.setup){this.setup=v.setup;setImmediate(()=>this.emit('message',Buffer.from(JSON.stringify({setupComplete:{}}))));}}close(){this.readyState=3;}}
 class Local extends EventEmitter{constructor(){super();this.readyState=1;}send(){}close(code=1000){this.readyState=3;this.emit('close',code);}}
 const native=new ClawLiveWarmCore({WebSocketImpl:Provider,tokenFactory:options=>live.createClawLiveToken(undefined,undefined,options)});
 const originalPrewarm=clawLiveWarmCore.prewarm;clawLiveWarmCore.prewarm=meta=>native.prewarm(meta);
 attachClawLiveWarmUpgrade(server,native);
 let socket;
 try{
  const catalog=await request('/v1/voice/voices');assert.equal(catalog.status,200);assert.equal(catalog.body.success,true);assert.equal(catalog.body.state,'ok');assert.equal(catalog.body.receipt,null);assert.equal(catalog.body.model,'gemini-3.8-live');assert.deepEqual(catalog.body.items.map(x=>x.id),[null,'Puck','Charon','Kore','Fenrir','Aoede','Leda','Orus','Zephyr']);assert.equal(catalog.body.appliesTo,"next_session");assert.equal(catalog.body.items[0].validation,"existing_default");assert.equal(catalog.body.items[0].validated,true);assert.ok(catalog.body.items.slice(1).every(x=>x.validated===false));assert.ok(catalog.body.items.every(x=>x.current===null));assert.ok(catalog.body.items.every(x=>typeof x.description==='string'&&x.description.length>0));assert.equal(catalog.body.items.find(x=>x.id==="Puck").description,"Voix enjouée.");assert.equal(catalog.body.items.find(x=>x.id==="Kore").description,"Voix ferme.");assert.equal(catalog.body.items.find(x=>x.id==="Charon").description,"Voix informative.");assert.ok(catalog.body.items.slice(1).every(x=>!x.description.includes("qualification")));assert.ok(catalog.body.items.slice(1).every(x=>x.label==='Voix '+x.id));assert.ok(!JSON.stringify(catalog.body).includes('test-private'));
  assert.equal((await request('/v1/voice/voices','POST',{})).status,405);assert.equal((await request('/v1/voice/voices','GET',undefined,{Origin:'https://untrusted.invalid'})).status,403);
  const baseline=live.buildClawLiveSetup('gemini-3.8-live',{home,client:'samantha_android'}).setup;
  assert.deepEqual(live.buildClawLiveSetup('gemini-3.8-live',{home,client:'samantha_android',voice:null}).setup,baseline);
  for(const voice of catalog.body.items.slice(1).map(x=>x.id)){
   const value=await request('/v1/extensions/claw-live/token','POST',{client:'samantha_android',voice});assert.equal(value.status,200);
   assert.equal(value.body.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,voice);
   const withoutVoice=structuredClone(value.body.setup);delete withoutVoice.generationConfig.speechConfig;assert.deepEqual(withoutVoice,baseline);
  }
  for(const voice of ['unknown','puck','',7,true,[],{},'Puck\n']){
   const before=minted;const denied=await request('/v1/extensions/claw-live/token','POST',{voice});assert.equal(denied.status,400);assert.equal(denied.body.error,'unknown_voice');assert.equal(minted,before);
   const prewarm=await request('/v1/extensions/claw-live/prewarm','POST',{voice});assert.equal(prewarm.status,400);assert.equal(prewarm.body.error,'unknown_voice');assert.equal(minted,before);
  }
  for(const options of [{},{voice:null}]){const value=await request('/v1/extensions/claw-live/token','POST',{client:'samantha_android',...options});assert.equal(value.status,200);assert.deepEqual(value.body.setup,baseline);}
  assert.deepEqual(await fs.readdir(home),[]);
  const meta=clawLiveWarmMeta({sessionId:'voice-a',voice:'Kore'});const first=await request('/v1/extensions/claw-live/prewarm','POST',{sessionId:'voice-a',voice:'Kore'});assert.equal(first.status,200);assert.equal(Provider.instances[0].setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,'Kore');assert.equal(Provider.instances[0].setup.model,'models/gemini-3.8-live');
  const local=new Local();await native.attach(local,meta);const old=structuredClone(Provider.instances[0].setup);
  await native.prewarm({sessionId:'__prewarm__',client:'samantha_android',locale:'fr',voice:'Puck'});assert.equal(Provider.instances.length,1);assert.deepEqual(Provider.instances[0].setup,old);
  local.close();const nextOwner=new Local();await native.attach(nextOwner,{...meta,voice:'Puck'});assert.equal(Provider.instances.length,2);assert.equal(Provider.instances.at(-1).setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,'Puck');
  nextOwner.close();const originalOwner=new Local();await native.attach(originalOwner,meta);assert.equal(Provider.instances.length,3);assert.equal(Provider.instances.at(-1).setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,'Kore');
  native.cool('test_resume',true);await native.prewarm({...meta,voice:'Puck'});assert.equal(Provider.instances.length,4);assert.equal(Provider.instances.at(-1).setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,'Kore');
  originalOwner.close();native.cool('session_finished');await native.prewarm({...meta,voice:'Puck'});assert.equal(Provider.instances.length,5);assert.equal(Provider.instances.at(-1).setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,'Puck');
  await assert.rejects(native.prewarm({...meta,voice:'other'}),/unknown_voice/);assert.equal(Provider.instances.length,5);
  const ownerV2=new Local();await native.attach(ownerV2,{...meta,voice:'Puck',protocol:2,sessionEpoch:'epoch-a',endpointing:'silero'});ownerV2.close();
  await new Promise(r=>setImmediate(r));await native.prewarmDefault();assert.equal(Provider.instances.at(-1).setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,'Puck');
  await native.prewarm({...meta,voice:'Leda'});assert.equal(Provider.instances.at(-1).setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,'Leda');
  native.cool();await native.prewarmDefault();assert.equal(Provider.instances.at(-1).setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,'Puck');
  const defaultOwner=new Local();await native.attach(defaultOwner,{...meta,voice:null,protocol:2,sessionEpoch:'epoch-default',endpointing:'silero'});assert.equal(Provider.instances.at(-1).setup.generationConfig.speechConfig,undefined);
  defaultOwner.close();await new Promise(r=>setImmediate(r));await native.prewarmDefault();assert.equal(Provider.instances.at(-1).setup.generationConfig.speechConfig,undefined);
  native.cool();await native.prewarmDefault();assert.equal(Provider.instances.at(-1).setup.generationConfig.speechConfig,undefined);assert.deepEqual(await fs.readdir(home),[]);
  const WebSocket=require('ws');
  await new Promise((resolve,reject)=>{const bad=new WebSocket('ws://127.0.0.1:'+server.address().port+'/v1/extensions/claw-live/socket?voice=unknown');bad.on('unexpected-response',(_req,res)=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>{try{assert.equal(res.statusCode,400);assert.equal(JSON.parse(body).error,'unknown_voice');resolve();}catch(e){reject(e);}});});bad.on('error',reject);});
  socket=new WebSocket('ws://127.0.0.1:'+server.address().port+'/v1/extensions/claw-live/socket?session=socket-a&voice=Zephyr');
  await new Promise((resolve,reject)=>{socket.on('message',raw=>{if(JSON.parse(raw).warmReady)resolve();});socket.on('error',reject);});
  assert.equal(Provider.instances.at(-1).setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,'Zephyr');
  socket.terminate();
  console.log('V5: closed unqualified catalogue, strict HTTP validation before token mint, unchanged default/setup/model, native setup capture, active connection unchanged, next-session choice and no storage writes passed');
 }finally{clawLiveWarmCore.prewarm=originalPrewarm;if(socket)socket.terminate();native.shutdown();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
