const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
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
 const lines=[];let mono=1000n;
 const telemetry=new VoiceTelemetry({enabled:true,monotonic:()=>mono++,calibrate:async()=>({boot:mono+5000n,mono:mono++,monoAfter:mono}),append:(_,line)=>lines.push(JSON.parse(line))});
 const core=new ClawLiveWarmCore({WebSocketImpl:Provider,telemetry,tokenFactory:async()=>bundle});
 try {
 const first=new Local();await core.attach(first,meta('legacy-shared',1));await telemetry.flush();
 assert(first.sent.some(v=>v.warmReady?.sessionEpoch==='legacy-shared'));const provider=Provider.instances.at(-1);first.close();
 const second=new Local();await core.attach(second,meta('',1));await telemetry.flush();await tick();
 const sid=second.sent.find(v=>v.warmReady).warmReady.sessionEpoch;assert(sid&&sid!=='legacy-shared');
 for(const code of ['t01','t07','t99'])assert(lines.some(v=>v.sid==='legacy-shared'&&v.ev===code),code);
 assert.equal(Provider.instances.at(-1),provider);for(const code of ['t01','t07'])assert(lines.some(v=>v.sid===sid&&v.ev===code));
 second.close();await tick();assert(!JSON.stringify(lines).includes('fixture-only'));assert(!lines.some(v=>v.ev==='t25p'));
 const off=new VoiceTelemetry({enabled:false,monotonic:()=>{throw Error('no clock')},append:()=>{throw Error('no write')}});
 const offCore=new ClawLiveWarmCore({WebSocketImpl:Provider,telemetry:off,tokenFactory:async()=>bundle});
 const offLocal=new Local();await offCore.attach(offLocal,meta('',1));assert(offLocal.sent.some(v=>v.warmReady?.sessionEpoch));offLocal.close();offCore.shutdown();assert.equal(off.status().written,0);
 // An immediate attach during calibration must keep each sid's offset, not drain the next sid's queue.
 const raceLines=[],pending=[];let raceMono=1000n,activeProbes=0,maxProbes=0;
 const race=new VoiceTelemetry({enabled:true,wall:()=>1,monotonic:()=>raceMono++,append:(_,line)=>raceLines.push(JSON.parse(line)),calibrate:()=>{activeProbes++;maxProbes=Math.max(maxProbes,activeProbes);const at=raceMono++;return new Promise(resolve=>pending.push(offset=>{activeProbes--;resolve({mono:at,boot:at+offset});}));}});
 race.emit('legacy-a',0,'t01');race.emit('legacy-b',0,'t01');assert.equal(pending.length,1);assert.equal(maxProbes,1);
 pending.shift()(5000n);await tick();assert.equal(pending.length,1);pending.shift()(15000n);await race.flush();
 const firstRace=raceLines.find(x=>x.sid==='legacy-a'),secondRace=raceLines.find(x=>x.sid==='legacy-b');assert(firstRace.boot_ns>=6000&&firstRace.boot_ns<6100);assert(secondRace.boot_ns>=16000&&secondRace.boot_ns<16100);assert.equal(maxProbes,1);
 const closing=race.closeSession('legacy-a');await tick();pending.shift()(17000n);await closing;
 assert.equal(raceLines.find(x=>x.sid==='legacy-a'&&x.ev==='t99').x.clock_drift_us,12);assert.equal(raceLines.find(x=>x.sid==='legacy-a'&&x.ev==='t99').x.clock_drift_truncated,false);assert.equal(race.status().failed,0);
 // Preserve the measured nanosecond delta as fractional microseconds; the marker describes representation, not acoustic/clock accuracy.
 let precisionMono=100n,precisionOffset=0n;const precisionLines=[];
 const precise=new VoiceTelemetry({enabled:true,wall:()=>1,monotonic:()=>precisionMono,calibrate:async()=>({mono:precisionMono,boot:precisionMono+precisionOffset}),append:(_,line)=>precisionLines.push(JSON.parse(line))});
 precise.emit('precise',0,'t01');await precise.flush();precisionOffset=1000001n;await precise.closeSession('precise');
 const preciseClose=precisionLines.find(x=>x.ev==='t99');assert.equal(preciseClose.x.clock_drift_us,1000.001);assert.equal(preciseClose.x.clock_drift_truncated,false);
 const compatibility=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-clock-schema-'));
 try{const file=path.join(compatibility,'emitted.jsonl');fs.writeFileSync(file,precisionLines.map(x=>JSON.stringify(x)).join('\n')+'\n');const check=spawnSync('python3',['-c','import runpy,sys;m=runpy.run_path(sys.argv[1]);assert len(m["read_events"]([sys.argv[2]]))==2',path.join(__dirname,'voice-m1-analyze.py'),file],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);}finally{fs.rmSync(compatibility,{recursive:true,force:true});}
 console.log(JSON.stringify({suite:'V2-legacy',passed:true,codes:['t01','t07','t99'],sharedSid:true,providerPreserved:true}));
 }finally{core.shutdown()}
})().catch(error=>{console.error(error);process.exitCode=1});
