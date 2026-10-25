// User-oriented live progress (Amine 25/10/2026): the agent's OpenClaw progress card feeds the run steps and the live
// text. Real S24 capture: fixtures/s24-2026-10-25-voice-brain/progress-card-get.json (progressCard.get).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const runs=require('../dist/companion/runs');
const {runProgressSteps}=require('../dist/companion/runProgress');
const capture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-25-voice-brain/progress-card-get.json'),'utf8'));
let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name);}
const KEY='agent:main:companion-chat-samantha-1';

(async()=>{
 await test('the real S24 card projects to readable steps and a plain note',()=>{
  const card=runs.projectProgressCard(capture.response);
  assert.deepEqual(card,{revision:2,updatedAt:1790209039115,
   steps:[{label:'Recueillir les états actuels',state:'done'},{label:'Recouper et résumer',state:'done'}],
   note:'Vérification terminée — états recoupés en direct.'});
 });
 await test('malformed or empty cards are dropped, labels are bounded and cleaned',()=>{
  for(const raw of [null,{},{card:null},{card:[]},{card:{revision:0,updatedAt:1,steps:[{step:'x',status:'completed'}]}},{card:{revision:1,updatedAt:1,steps:[],markdown:'  '}},{card:{revision:1,updatedAt:'x',steps:[{step:'x',status:'completed'}]}}])
   assert.equal(runs.projectProgressCard(raw),null,JSON.stringify(raw));
  const card=runs.projectProgressCard({card:{revision:3,updatedAt:5,steps:[
   {step:'<b>Je regarde</b> tes factures‮','status':'in_progress'},{step:'',status:'pending'},{step:'Inconnu',status:'weird'},{step:'x'.repeat(400),status:'pending'}]}});
  assert.deepEqual(card.steps.map(s=>s.state),['running','pending']);
  assert.equal(card.steps[0].label,'Je regarde tes factures');assert.equal(card.steps[1].label.length,160);
 });
 await test('a card older than the run belongs to an earlier task and is ignored; polls share one Gateway read',async()=>{
  let reads=0,t=1000;const read=async()=>{reads++;return {card:{revision:4,updatedAt:900,steps:[{step:'Je regarde tes factures',status:'in_progress'}]}};};
  assert.equal(await runs.readRunProgressCard(KEY,950,read,()=>t),null,'card older than the run');
  assert.equal(reads,1);
  const fresh=await runs.readRunProgressCard(KEY,800,read,()=>t);assert.equal(fresh.steps[0].label,'Je regarde tes factures');
  assert.equal(reads,1,'same TTL window: no second Gateway call');
  t+=2000;await runs.readRunProgressCard(KEY,800,read,()=>t);assert.equal(reads,2,'refreshed after the TTL');
  assert.equal(await runs.readRunProgressCard('not a key',1,read,()=>t),null);assert.equal(reads,2,'invalid key: no call');
  assert.equal(await runs.readRunProgressCard('agent:main:x',1,async()=>{throw new Error('gateway down');},()=>t+9000),null,'a Gateway failure is no card');
 });
 await test('the running card step becomes the live text; the steps replace the technical tool events',()=>{
  const card={revision:5,updatedAt:2000,steps:[{label:'Je récupère tes factures',state:'done'},{label:'Je compare avec le mois dernier',state:'running'},{label:'Je prépare la réponse',state:'pending'}]};
  const progress=runs.withProgressCard({text:'Calling exec.',events:[{type:'tool.call',label:'Calling exec.',at:1990}]},card);
  assert.equal(progress.text,'Je compare avec le mois dernier');assert.equal(progress.card,card);
  const steps=runProgressSteps({executionSource:'gateway',state:'running',acceptedAt:1000,events:progress.events,card});
  assert.deepEqual(steps.steps.map(s=>[s.label,s.state]),[['Demande reçue','done'],['Je récupère tes factures','done'],['Je compare avec le mois dernier','running'],['Je prépare la réponse','pending']]);
  assert.ok(!steps.steps.some(s=>/Calling|exec/.test(s.label)));
  const done=runProgressSteps({executionSource:'gateway',state:'done',acceptedAt:1000,updatedAt:3000,card});
  assert.deepEqual(done.steps.map(s=>s.state),['done','done','done','skipped','done']);
  const failed=runProgressSteps({executionSource:'gateway',state:'failed',acceptedAt:1000,updatedAt:3000,card});
  assert.deepEqual(failed.steps.map(s=>s.state),['done','done','failed','skipped','failed']);assert.equal(failed.failedStep,'Je compare avec le mois dernier');
 });
 await test('without a card, a tool name never becomes a step (point E, test-run-progress-titles.cjs)',()=>{
  const steps=runProgressSteps({executionSource:'gateway',state:'running',acceptedAt:1000,events:[{type:'tool.call',label:'Calling read.',at:1100,seq:1}]});
  assert.deepEqual(steps.steps.map(s=>s.label),['Demande reçue','Réponse de Samantha']);
  assert.equal(runs.withProgressCard(undefined,null),undefined);
 });
 console.log(JSON.stringify({passed,failed:0,fixture:'s24-2026-10-25-voice-brain/progress-card-get.json'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
