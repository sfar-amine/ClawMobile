const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {VoiceTelemetry}=require('../dist/companion/voiceTelemetry');
const {VoiceTurnProtocol}=require('../dist/companion/voiceTurnProtocol');
let passed=0;
function test(name,run){run();passed++;console.log('PASS '+name)}
const codes=['t01','t02','t03','t04','t05','t06','t07','t25p','t30p','t44'];
test('disabled has no clock or disk side effects',()=>{
 const t=new VoiceTelemetry({enabled:false,clock:()=>{throw Error('called')},append:()=>{throw Error('called')}});
 t.emit('s',0,'t01');assert.equal(t.status().written,0);assert.equal(t.status().failed,0);
});
test('all C1 producer codes, exact integer and technical-only schema',()=>{
 const lines=[],t=new VoiceTelemetry({enabled:true,clock:()=>9007199254740993n,wall:()=>1791540000000,append:(file,line)=>lines.push({file,line})});
 codes.forEach(ev=>t.emit('epoch',0,ev,{connection:2}));
 assert.equal(lines.length,10);assert(lines.every(v=>v.line.includes('"boot_ns":9007199254740993,')));
 for(const {file,line} of lines){const e=JSON.parse(line);assert.deepEqual(Object.keys(e),['schema','src','sid','turn','ev','boot_ns','wall_ms','x']);assert.equal(e.schema,'samantha.voice.telemetry.v1');assert.equal(e.src,'companion');assert(file.endsWith('.jsonl'));assert.equal(e.x.connection,2)}
});
test('unsafe session, metadata, turn and event are rejected before logging',()=>{
 for(const [sid,turn,ev,x] of [['a',0,'t01',{token:'private'}],['a',0,'t01',{attempt:'private'}],['../a',0,'t01',{}],['a',-1,'t01',{}],['a',0,'transcript',{}]]) {
  const lines=[];let probes=0;
  const t=new VoiceTelemetry({enabled:true,clock:()=>{probes++;return 1n},append:(_,line)=>lines.push(line)});
  t.emit(sid,turn,ev,x);
  assert.equal(lines.length,0);assert.equal(probes,0);assert.equal(t.status().failed,1);
 }
});
test('clock and append failures never reach Voice callers',()=>{
 for(const opts of [{clock:()=>{throw Error('secret')}},{clock:()=>-1n},{clock:()=>1n,append:()=>{throw Error('secret')}}]){
 const t=new VoiceTelemetry({enabled:true,...opts});assert.doesNotThrow(()=>t.emit('a',0,'t01'));assert.equal(t.status().failed,1);assert.equal(t.status().written,0)}
});
test('failed clock is fenced for the recorder lifetime',()=>{
 let calls=0;const t=new VoiceTelemetry({enabled:true,clock:()=>{calls++;throw Error('fixture')}});
 t.emit('a',0,'t01');t.emit('a',0,'t02');assert.equal(calls,1);assert.equal(t.status().failed,2);assert.equal(t.status().available,false);
});
test('protocol observation is idempotent and cannot alter business messages',()=>{
 const seen=[],sent=[],p=new VoiceTurnProtocol(1,'epoch',v=>sent.push(v),()=>{},(ev,id)=>seen.push([ev,id]));
 const start={warmControl:{turnStart:{operationId:'start-a',sessionEpoch:'epoch',turnId:'a',firstSample:0}}};
 p.receive(start);p.receive(start);
 const end={warmControl:{turnEnd:{operationId:'end-a',sessionEpoch:'epoch',turnId:'a',lastSampleExclusive:0}}};p.receive(end);p.receive(end);
 const audio={serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm',data:'AA=='}}]}}};p.provider(audio);p.provider(audio);
 p.provider({serverContent:{interrupted:true}});p.provider({serverContent:{interrupted:true}});
 assert.deepEqual(seen,[['input_start','a'],['t25p','a'],['t30p','a'],['t44','a']]);assert.equal(sent.length,2);
});
test('observer failure cannot stop protocol forwarding',()=>{
 const sent=[],p=new VoiceTurnProtocol(1,'epoch',v=>sent.push(v),()=>{},()=>{throw Error('observer')});
 p.receive({warmControl:{turnStart:{operationId:'start',sessionEpoch:'epoch',turnId:'a',firstSample:0}}});assert.equal(sent.length,1);
});
async function asyncTests(){
 async function atest(name,run){await run();passed++;console.log('PASS '+name)}
 await atest('calibrated mode: one probe per session, hrtime + offset, queued events written once known',async()=>{
  let mono=1000n,probes=0;const lines=[];
  const t=new VoiceTelemetry({enabled:true,wall:()=>1791540000000,monotonic:()=>mono,append:(_,line)=>lines.push(JSON.parse(line)),
   calibrate:async()=>{probes++;return {boot:mono+5000n,mono:mono};}});
  t.emit('s1',0,'t01');mono=2000n;t.emit('s1',0,'t02');
  await t.flush();mono=3000n;t.emit('s1',1,'t25p');
  assert.equal(probes,1);assert.deepEqual(lines.map(e=>[e.ev,e.boot_ns]),[['t01',6000],['t02',7000],['t25p',8000]]);
  assert.equal(t.status().mode,'session_offset');assert.equal(t.status().pending,0);
 });
 await atest('new session recalibrates and reports drift across a suspend',async()=>{
  let mono=10n,offset=5000n;const t=new VoiceTelemetry({enabled:true,monotonic:()=>mono,append:()=>{},calibrate:async()=>({boot:mono+offset,mono})});
  t.emit('a',0,'t01');await t.flush();offset=2_005_000n;t.emit('b',0,'t01');await t.flush();
  assert.equal(t.status().driftUs,2000);assert.equal(t.status().suspendDetected,true);assert.equal(t.status().written,2);
 });
 await atest('close-time check writes t99 with clock_drift_us for the session (suspend excluded by A10)',async()=>{
  let mono=10n,offset=5000n;const lines=[];
  const t=new VoiceTelemetry({enabled:true,wall:()=>1,monotonic:()=>mono,append:(_,l)=>lines.push(JSON.parse(l)),calibrate:async()=>({boot:mono+offset,mono})});
  t.emit('s',0,'t01');await t.flush();offset=1_505_000n;mono=20n;await t.closeSession('s');
  const close=lines.find(e=>e.ev==='t99');assert.equal(close.sid,'s');assert.equal(close.turn,0);assert.equal(close.x.clock_drift_us,1500);
  assert.equal(t.status().suspendDetected,true);
  const quiet=new VoiceTelemetry({enabled:true,wall:()=>1,monotonic:()=>mono,append:(_,l)=>lines.push(JSON.parse(l)),calibrate:async()=>({boot:mono+7n,mono})});
  quiet.emit('q',0,'t01');await quiet.flush();await quiet.closeSession('q');
  assert.equal(lines.filter(e=>e.sid==='q'&&e.ev==='t99')[0].x.clock_drift_us,0);
  const off=new VoiceTelemetry({enabled:false,calibrate:async()=>{throw Error('must not probe')}});await off.closeSession('x');
 });
 await atest('probe MONOTONIC outside the hrtime bracket disqualifies the clock',async()=>{
  const t=new VoiceTelemetry({enabled:true,monotonic:()=>100n,append:()=>{throw Error('must not write')},calibrate:async()=>({boot:9n,mono:5n})});
  t.emit('a',0,'t01');await t.flush();assert.equal(t.status().available,false);assert.equal(t.status().written,0);assert.equal(t.status().failed,1);
 });
 await atest('real S24-style calibration writes private JSONL without a probe per event',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-m1-telemetry-'));
  try{const t=new VoiceTelemetry({enabled:true,home:root});t.emit('real-fixture',0,'t01');t.emit('real-fixture',0,'t02');await t.flush();
  assert.equal(t.status().failed,0);assert.equal(t.status().written,2);
  const dir=path.join(root,'.openclaw/telemetry/voice'),file=path.join(dir,fs.readdirSync(dir)[0]);
  assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(dir).mode&0o777,0o700);
  const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(l=>JSON.parse(l));assert(rows.every(e=>e.boot_ns>0&&e.x.clock_probe_us===0));
  assert(rows[1].boot_ns>=rows[0].boot_ns);
  console.log(JSON.stringify({fixtureClock:'CLOCK_BOOTTIME',calibrationUs:t.status().calibrationUs,perEventProbeUs:t.status().maxProbeUs,notS24:true}));
  }finally{fs.rmSync(root,{recursive:true,force:true})}
 });
}
asyncTests().then(()=>console.log(JSON.stringify({passed,failed:0,scope:'M1-A8-C1-offline'}))).catch(e=>{console.error(e);process.exit(1)});
