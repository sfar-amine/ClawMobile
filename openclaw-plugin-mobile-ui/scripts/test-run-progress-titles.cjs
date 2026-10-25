// Point E (Amine 25/10/2026, 10:46): live progress stays readable without a progress card. Real S24 capture of run
// run_1792920553461_9ffdf172 (« détail du blocage »): 6 start-up rule reads, tool/memory searches, titled execs.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const runs=require('../dist/companion/runs');
const {runProgressSteps,isTechnicalProgressLabel}=require('../dist/companion/runProgress');
const capture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-25-progress-titles/chat-history-run.json'),'utf8'));
let passed=0;
function test(name,run){run();passed++;console.log('PASS '+name);}
// The Companion's own transcript fallback: chat.history messages wrapped as transcript lines (runs.ts readSessionTranscript).
const raw=(until=Infinity)=>capture.messages.filter(m=>m.timestamp<=until).map(message=>JSON.stringify({type:'message',message,timestamp:message.timestamp})).join('\n');
const events=until=>runs.summarizeTranscript(raw(until)).progressEvents;
const steps=(until,state='running')=>runProgressSteps({executionSource:'gateway',state,acceptedAt:1792920553461,updatedAt:1792920632438,events:events(until)}).steps;
const view=list=>list.map(s=>`${s.id}:${s.state}:${s.label}`);
const TOOL=/\b(exec|read|tool_search|tool_call|memory_search|process|Calling|Completed|Tool failed|Reading files|Internal tool)\b/;

test('transcript events carry the agent title, the call id and the start-up context flag, never as a label',()=>{
 const ev=events();
 const titled=ev.filter(e=>e.title);
 assert.deepEqual(titled.map(e=>e.title),['Charger le contexte du blocage','Lire le checkpoint Voix v2','Repérer les preuves CI récentes',
  'Localiser les outils de contexte et CI','Trouver les outils canoniques','Lire le checkpoint exact Voix v2','Vérifier le statut actuel de la PR 407','Lire le checkpoint exact Voix v2']);
 assert.equal(ev.filter(e=>e.context).length,6);
 assert.ok(ev.filter(e=>e.type!=='tool.call').every(e=>typeof e.callId==='string'));
});
test('the finished run shows the agent titles, one preparing line, no tool name, no running icon',()=>{
 const done=steps(Infinity,'done');
 assert.deepEqual(view(done),[
  'accepted:done:Demande reçue',
  'prepare:done:Je prépare ta demande',
  'agent-2:skipped:Lire le checkpoint Voix v2',
  'agent-3:done:Repérer les preuves CI récentes',
  'agent-4:done:Localiser les outils de contexte et CI',
  'agent-5:done:Trouver les outils canoniques',
  'agent-6:skipped:Lire le checkpoint exact Voix v2',
  'agent-7:done:Vérifier le statut actuel de la PR 407',
  'agent-8:done:Lire le checkpoint exact Voix v2',
  'answer:done:Réponse de Samantha']);
 assert.ok(!TOOL.test(JSON.stringify(done)),JSON.stringify(done));
 assert.ok(!done.some(s=>s.state==='running'));
});
test('while the six start-up reads run, a single « Je prépare ta demande » line is running',()=>{
 const s=steps(1792920577900);
 assert.deepEqual(view(s),['accepted:done:Demande reçue','agent-1:done:Charger le contexte du blocage','prepare:running:Je prépare ta demande']);
});
test('a titled step is running until its result, then done; untitled searches never show',()=>{
 const s=steps(1792920591300);
 assert.deepEqual(view(s).slice(-2),['agent-4:done:Localiser les outils de contexte et CI','agent-5:running:Trouver les outils canoniques']);
 assert.ok(!TOOL.test(JSON.stringify(s)));
 // Only an untitled process poll is in flight: nothing technical, the answer is what is in progress.
 const poll=steps(1792920603000);
 assert.equal(poll.filter(x=>x.state==='running').length,1);assert.equal(poll.at(-1).id,'answer');assert.equal(poll.at(-1).state,'running');
});
test('identical consecutive steps are merged in the state of the last attempt',()=>{
 const retry=[{type:'tool.call',label:'Calling exec.',title:'Lire le checkpoint',callId:'a',at:1},{type:'tool.error',label:'Tool failed exec.',callId:'a',at:2},
  {type:'tool.call',label:'Calling exec.',title:'Lire le checkpoint',callId:'b',at:3},{type:'tool.result',label:'Completed exec.',callId:'b',at:4}];
 const s=runProgressSteps({executionSource:'gateway',state:'running',acceptedAt:0,events:retry}).steps;
 assert.deepEqual(view(s),['accepted:done:Demande reçue','agent-1:done:Lire le checkpoint','answer:running:Réponse de Samantha']);
 const labels=runProgressSteps({executionSource:'gateway',state:'running',acceptedAt:0,events:[{type:'tool',label:'Lecture des factures',at:1,seq:1},{type:'tool',label:'Lecture des factures',at:2,seq:2}]}).steps;
 assert.deepEqual(view(labels),['accepted:done:Demande reçue','event-1:running:Lecture des factures']);
});
test('technical transport labels never become steps nor live text',()=>{
 const s=runProgressSteps({executionSource:'gateway',state:'done',acceptedAt:0,updatedAt:5,events:[{type:'companion.completed',label:'Completed.',at:5,seq:1},{type:'tool.call',label:'Calling memory_search.',at:2}]}).steps;
 assert.deepEqual(view(s),['accepted:done:Demande reçue','answer:done:Réponse de Samantha']);
 for(const l of ['Calling exec.','Completed read.','Tool failed exec.','Completed.','Working...','Started OpenClaw session.',''])assert.ok(isTechnicalProgressLabel(l),l);
 for(const l of ['Lire le checkpoint Voix v2','Je prépare ta demande'])assert.ok(!isTechnicalProgressLabel(l),l);
});
console.log(JSON.stringify({passed,failed:0,fixture:'s24-2026-10-25-progress-titles/chat-history-run.json'}));
