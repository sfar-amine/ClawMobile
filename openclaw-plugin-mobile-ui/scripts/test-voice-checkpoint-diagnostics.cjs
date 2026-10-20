// Real S24 event timing replay in an explicit new protocol envelope; no physical recipe claimed.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-checkpoint-diagnostics-'));
process.env.OPENCLAW_STATE_DIR=root;
const owner=require('../dist/companion/runs.js');
const contract=require('../fixtures/protocol/voice-turn-diagnostics-v1.json');
const copy=value=>JSON.parse(JSON.stringify(value));
let tests=0;
async function test(name,fn){await fn();tests++;}
const invalid=async value=>assert.throws(()=>owner.validateVoiceDiagnostics(value),e=>e.statusCode===400&&e.message==='invalid_voice_diagnostics');

async function main(){
 await test('canonical C1 and F2 copies agree with the protocol fixture',()=>{
  assert.deepEqual([...owner.VOICE_DIAGNOSTIC_EVENTS],contract.events);
  assert.deepEqual([...owner.VOICE_DIAGNOSTIC_FAILURE_FAMILIES],contract.failureFamilies);
  assert.ok(contract.provenance.includes('S24 18/10/2026'));
  assert.deepEqual(owner.validateVoiceDiagnostics(contract.example),contract.example);
 });
 await test('absent diagnostics remain absent and validated projection is detached',()=>{
  assert.equal(owner.validateVoiceDiagnostics(undefined),undefined);
  const input=copy(contract.example),out=owner.validateVoiceDiagnostics(input);
  input.events[1].failureFamily='PRIVATE';out.events[0].elapsedMs=1;
  assert.equal(out.events[1].failureFamily,'correlation');assert.equal(input.events[0].elapsedMs,0);
 });
 await test('private values, arbitrary fields, unknown codes and misplaced families are refused',async()=>{
  for(const value of [null,[],{},'private',true])await invalid(value);
  for(const patch of [{text:'PRIVATE_ACCOUNT@example.invalid'},{audio:'PRIVATE'},{token:'PRIVATE'}])await invalid({...copy(contract.example),...patch});
  for(const patch of [{code:'PRIVATE_ACCOUNT@example.invalid'},{code:'t99'},{failureFamily:'PRIVATE_TOKEN_VALUE'},{message:'PRIVATE'},{stage:'private'}]){
   const value=copy(contract.example);Object.assign(value.events[1],patch);await invalid(value);
  }
  const misplaced=copy(contract.example);misplaced.events[0].failureFamily='token';await invalid(misplaced);
 });
 await test('all counts and times are bounded finite integers and ordered',async()=>{
  for(const startedAtMs of [-1,true,1.5,NaN,Infinity,contract.maxAtMs+1])await invalid({...copy(contract.example),startedAtMs});
  for(const elapsedMs of [-1,true,1.5,NaN,Infinity,contract.maxElapsedMs+1]){
   const value=copy(contract.example);value.events[1].elapsedMs=elapsedMs;await invalid(value);
  }
  const backwards=copy(contract.example);backwards.events[2].elapsedMs=1;await invalid(backwards);
  await invalid({...copy(contract.example),truncated:1});
  await invalid({...copy(contract.example),events:Array.from({length:contract.maxEvents+1},()=>({code:'t00',elapsedMs:0}))});
  await invalid({...copy(contract.example),startedAtMs:contract.maxAtMs});
  const boundary={version:1,startedAtMs:0,truncated:true,events:Array.from({length:32},()=>({code:'t00',elapsedMs:contract.maxElapsedMs}))};
  assert.deepEqual(owner.validateVoiceDiagnostics(boundary),boundary);
  const saturated={...boundary,events:Array.from({length:32},()=>({code:'t90',elapsedMs:contract.maxElapsedMs,failureFamily:'before_setup'}))};
  assert.ok(Buffer.byteLength(JSON.stringify(owner.validateVoiceDiagnostics(saturated)))<4096);
 });
 const session='samantha-00000000-0000-4000-8000-00000000f003';
 const runId='voice-00000000-0000-4000-8000-00000000f003';
 const payload={runId,revision:1,input:'PRIVATE_REQUEST',output:'PRIVATE_RESULT',state:'partial',diagnostics:copy(contract.example)};
 await test('existing receipt persists and reprojects only the closed diagnostic summary',async()=>{
  const first=await owner.saveVoiceTurn(session,payload);assert.equal(first.state,'unknown');
  assert.deepEqual(first.voiceDiagnostics,contract.example);
  const stored=JSON.parse(fs.readFileSync(path.join(root,'clawmobile-companion/runs.json'),'utf8')).runs[0];
  assert.deepEqual(stored.voiceDiagnostics,contract.example);assert.equal(stored.diagnostics,undefined);
  const reread=(await owner.getConversationTurns(session))[0];assert.deepEqual(reread.voiceDiagnostics,contract.example);
 });
 await test('revision replay and terminal state rules are unchanged',async()=>{
  const replay=await owner.saveVoiceTurn(session,{...payload,diagnostics:{...contract.example,events:[]}});
  assert.deepEqual(replay.voiceDiagnostics,contract.example);
  const done=await owner.saveVoiceTurn(session,{...payload,revision:2,state:'completed',diagnostics:undefined});
  assert.equal(done.state,'done');assert.equal(done.transcriptState,'completed');assert.deepEqual(done.voiceDiagnostics,contract.example);
  await assert.rejects(owner.saveVoiceTurn(session,{...payload,revision:3,state:'interrupted'}),e=>e.statusCode===409&&e.message==='turn_already_final');
  const id2='voice-00000000-0000-4000-8000-00000000f004';
  const legacy=await owner.saveVoiceTurn(session,{runId:id2,revision:1,input:'x',output:'y',state:'completed'});
  assert.equal(legacy.state,'done');assert.equal(legacy.voiceDiagnostics,undefined);
 });
 await test('malformed input has no write and malformed stored metadata cannot leak',async()=>{
  const file=path.join(root,'clawmobile-companion/runs.json'),before=fs.readFileSync(file,'utf8');
  await assert.rejects(owner.saveVoiceTurn(session,{...payload,revision:3,diagnostics:{...contract.example,secret:'PRIVATE'}}),e=>e.statusCode===400&&e.message==='invalid_voice_diagnostics');
  assert.equal(fs.readFileSync(file,'utf8'),before);
  const data=JSON.parse(before);data.runs.find(r=>r.runId===runId).voiceDiagnostics.events[1].message='PRIVATE_TRACE_CONTENT';
  fs.writeFileSync(file,JSON.stringify(data));
  const reread=(await owner.getConversationTurns(session)).find(r=>r.runId===runId);
  assert.equal(reread.voiceDiagnostics,undefined);assert.equal(reread.result,'PRIVATE_RESULT');
 });
 console.log(JSON.stringify({suite:'f3-voice-checkpoint-diagnostics',tests,source:'S24 18/10 event timestamps; new envelope explicitly projected',physicalRecipe:false}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
