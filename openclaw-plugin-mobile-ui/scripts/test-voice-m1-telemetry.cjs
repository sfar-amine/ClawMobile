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
test('real BOOTTIME clock writes private JSONL in temporary existing owner path',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-m1-telemetry-'));
 try{const t=new VoiceTelemetry({enabled:true,home:root});t.emit('real-fixture',0,'t01');assert.equal(t.status().failed,0);assert.equal(t.status().written,1);
 const dir=path.join(root,'.openclaw/telemetry/voice'),file=path.join(dir,fs.readdirSync(dir)[0]);
 assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(dir).mode&0o777,0o700);
 const e=JSON.parse(fs.readFileSync(file,'utf8'));assert(e.boot_ns>0);assert(e.x.clock_probe_us>=0);
 console.log(JSON.stringify({fixtureClock:'CLOCK_BOOTTIME',probeUs:t.status().maxProbeUs,notS24:true}));
 }finally{fs.rmSync(root,{recursive:true,force:true})}
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
console.log(JSON.stringify({passed,failed:0,scope:'M1-A8-C1-offline'}));
