// L6 route reachability: stored terminal run + real S24 17-call chat.history capture.
// The private owner text/result are redacted in the capture; authored sentinels below check they are never replaced.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'samantha-terminal-progress-'));
process.env.OPENCLAW_STATE_DIR=root;process.env.CLAWMOBILE_AGENT_ID='main';
const capture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-25-progress-titles/chat-history-run.json'),'utf8'));
const client=require('../dist/companion/openclawAgentClient');
const key='agent:main:companion-chat-terminal-recipe';
const registry=path.join(root,'clawmobile-companion/runs.json');fs.mkdirSync(path.dirname(registry),{recursive:true});
let sessions=0,histories=0,cards=0,mode='normal';
client.callOpenClawGateway=async(method,params,options)=>{
 if(method==='sessions.list'){sessions++;return {sessions:[{key:mode==='wrong-session'?key+'-other':key,sessionId:'s24-real-capture',status:'completed'}]};}
 if(method==='progressCard.get'){cards++;return {card:null};}
 assert.equal(method,'chat.history');assert.equal(params.sessionKey,key);assert.equal(params.limit,200);assert.ok(options.timeoutMs<=5500);histories++;
 if(mode==='slow')await new Promise(r=>setTimeout(r,2800));
 if(mode==='late')return {messages:capture.messages.map(m=>({...m,timestamp:m.timestamp+3600000}))};
 return {messages:[...capture.messages,...(mode==='repeat'?[{role:'user',timestamp:1792924154377,content:[{type:'text',text:'<owner prompt redacted>'}]},{role:'assistant',timestamp:1792924155000,content:[{type:'toolCall',name:'exec',id:'later',arguments:{title:'Autre demande à ne pas afficher'}}]}]:[])]};
};
const runs=require('../dist/companion/runs');
function store(id){fs.writeFileSync(registry,JSON.stringify({version:1,runs:[{runId:id,sessionId:'terminal-recipe',sessionKey:key,executionSource:'gateway',text:'<owner prompt redacted>',acceptedAt:1792920553461,updatedAt:1792920632438,state:'done',result:'ORIGINAL_RESULT_UNCHANGED',ownerAdmitted:true}],archivedSessionIds:[],paymentRequests:[],ownerConfirmations:[]}));return fs.readFileSync(registry,'utf8');}
(async()=>{
 const original=store('run_1792920553461_9ffdf172');
 const [a,b]=await Promise.all([runs.getRunStatus('run_1792920553461_9ffdf172'),runs.getRunStatus('run_1792920553461_9ffdf172')]);
 assert.equal(a.state,'done');assert.equal(a.result,'ORIGINAL_RESULT_UNCHANGED');assert.equal(a.message,'ORIGINAL_RESULT_UNCHANGED');assert.equal(a.ownerAdmitted,true);
 assert.ok(a.progress.steps.some(s=>s.label==='Lire le checkpoint Voix v2'));assert.ok(a.progress.steps.some(s=>s.label==='Vérifier le statut actuel de la PR 407'));
 assert.ok(a.progress.steps.every(s=>s.state!=='running'));assert.equal(a.progress.text,'Réponse de Samantha');assert.deepEqual(a.progress,b.progress);
 assert.equal(histories,1);assert.equal(sessions,1);assert.equal(cards,1);assert.equal(fs.readFileSync(registry,'utf8'),original,'the original run is never rewritten');
 await runs.getRunStatus('run_1792920553461_9ffdf172');assert.equal(histories,1,'terminal details reuse a bounded projection cache');
 await runs.listRuns();assert.equal(histories,1,'lists never reconstruct terminal progress per row');
 mode='wrong-session';store('run_wrong_session');const wrong=await runs.getRunStatus('run_wrong_session');assert.equal(histories,1);assert.ok(!wrong.progress.steps.some(s=>s.id.startsWith('agent-')));
 mode='late';store('run_wrong_turn');const late=await runs.getRunStatus('run_wrong_turn');assert.ok(!late.progress.steps.some(s=>s.id.startsWith('agent-')),'same text outside admission window cannot contribute steps');
 mode='repeat';store('run_repeat_turn');const repeat=await runs.getRunStatus('run_repeat_turn');assert.ok(repeat.progress.steps.some(s=>s.label==='Lire le checkpoint Voix v2'));assert.ok(!repeat.progress.steps.some(s=>s.label==='Autre demande à ne pas afficher'));
 assert.equal(repeat.state,'done');assert.equal(repeat.result,'ORIGINAL_RESULT_UNCHANGED');
 mode='slow';const slowOriginal=store('run_slow_terminal');const started=Date.now();const slow=await runs.getRunStatus('run_slow_terminal');
 assert.ok(Date.now()-started<2750,'detail response stays inside its2.5s wait budget with realistic slow owner');
 assert.ok(!slow.progress.steps.some(s=>s.id.startsWith('agent-')));assert.equal(slow.state,'done');assert.equal(slow.result,'ORIGINAL_RESULT_UNCHANGED');
 await new Promise(r=>setTimeout(r,400));const refreshed=await runs.getRunStatus('run_slow_terminal');
 assert.ok(refreshed.progress.steps.some(s=>s.label==='Lire le checkpoint Voix v2'),'the next poll sees the same completed background read');
 assert.equal(fs.readFileSync(registry,'utf8'),slowOriginal);

 console.log('PASS terminal getRunStatus: real17-call capture, exact session/time, no receipt mutation, single-flight/cache, no list fanout');
 fs.rmSync(root,{recursive:true,force:true});
})().catch(e=>{console.error(e);process.exitCode=1;});
