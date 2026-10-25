// Brain delegation of Samantha Voix (Amine 25/10/2026: « il doit absolument tout déléguer au cerveau »).
// Real S24 captures: fixtures/s24-2026-10-25-voice-brain (SOUL, voice file, operating rules, claw_live resolutions).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const live=require('../dist/companion/clawLive');
const {clawLiveDecision,clawLiveCapability,VoiceUnderstandingState}=require('../dist/companion/clawLiveUnderstanding');
const brain=require('../dist/companion/voiceBrainDelegation');

const FIX=path.join(__dirname,'../fixtures/s24-2026-10-25-voice-brain');
const resolutions=JSON.parse(fs.readFileSync(path.join(FIX,'resolve-claw_live.json'),'utf8'));
const deterministic=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/o7-o8-orange-20261010-0941.json'),'utf8'));
let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name);}

const home=fs.mkdtempSync(path.join(os.tmpdir(),'voice-brain-'));
const work=path.join(home,'.openclaw','workspace');
fs.cpSync(path.join(FIX,'s24-workspace'),work,{recursive:true});
// Personal files are never captured: synthetic markers prove what each surface receives.
fs.writeFileSync(path.join(work,'USER.md'),'USER_MARKER_PRIVATE');
fs.writeFileSync(path.join(work,'context','HYBRID_CONTEXT.md'),'# Claw Hybrid Conversation Context — Amine\nHYBRID_MARKER_MEMORY_VIEW\n');
const voiceRaw=fs.readFileSync(path.join(work,'memory','voice','amine.md'),'utf8');

function owner(){return {understanding:new VoiceUnderstandingState(),sessionLocale:()=>'fr',executeVoiceCapability:(_m,_r,run)=>run()};}
const resolution=(request)=>resolutions.cases.find(c=>c.request===request).resolution;

(async()=>{
 try{
  // --- Gemini Live contract of the Android voice ---
  const android=live.buildClawLiveSetup('gemini-3.8-live',{home,client:'samantha_android'}).setup;
  const prompt=android.systemInstruction.parts[0].text;
  const tools=android.tools[0].functionDeclarations;
  await test('android voice declares ask_samantha first, verbatim and blocking',()=>{
   assert.deepEqual(tools.map(t=>t.name),['ask_samantha','clawmobile_capability']);
   const ask=tools[0];assert.equal(ask.behavior,'BLOCKING');assert.deepEqual(Object.keys(ask.parameters.properties),['request']);assert.deepEqual(ask.parameters.required,['request']);
   assert.match(ask.description,/every turn/);
  });
  await test('clawmobile_capability is reserved to answering a needs_clarification receipt',()=>{
   const cap=tools[1];assert.deepEqual(cap.parameters.required,['request','clarificationId']);assert.match(cap.description,/^Only to send/);assert.match(cap.description,/Never for a new request/);
  });
  await test('android instruction delegates every turn and forbids answering alone',()=>{
   assert.match(prompt,/brain delegation v1/);
   assert.match(prompt,/ABSOLUTE RULE: every time Amine speaks, call ask_samantha/);
   assert.match(prompt,/Never answer from your own knowledge, from the conversation history or from these instructions/);
   assert.match(prompt,/Never say that something is saved, noted, remembered, done, adjusted, checked or sent unless the returned text says so/);
   assert.match(prompt,/never invoke confidentiality yourself/);
   assert.ok(prompt.includes('contains voice.verbatim, start your spoken answer with exactly that text, word for word'));
   assert.ok(!/Pure conversation|may be answered directly/.test(prompt),'the free-answer loophole is gone');
  });
  await test('android voice receives identity and speaking style only, never the agent harness or memory',()=>{
   assert.ok(prompt.includes('# SOUL.md — Samantha'));
   assert.ok(prompt.includes('## Interaction vocale'));
   for(const absent of ['## OPERATING_RULES','request_context.py','Règles spécialisées','## HYBRID_CONTEXT','HYBRID_MARKER_MEMORY_VIEW','USER_MARKER_PRIVATE',
     '## Calibration','## Décisions / règles validées','checkpoint toutes les 5 minutes','## Historique compact'])
    assert.ok(!prompt.includes(absent),'android voice prompt must not contain '+absent);
   assert.ok(Buffer.byteLength(prompt)<16000,'bounded voice bootstrap: '+Buffer.byteLength(prompt));
   assert.deepEqual(android.realtimeInputConfig,{automaticActivityDetection:{disabled:true},activityHandling:'START_OF_ACTIVITY_INTERRUPTS'});
  });
  await test('other clients keep the legacy contract unchanged (scope = Samantha Android voice)',()=>{
   const browser=live.buildClawLiveSetup('gemini-3.8-live',{home}).setup;
   assert.deepEqual(browser.tools[0].functionDeclarations.map(t=>t.name),['clawmobile_capability','ask_samantha']);
   assert.ok(browser.systemInstruction.parts[0].text.includes('## OPERATING_RULES'));
   assert.equal(browser.realtimeInputConfig,undefined);
  });
  await test('voice style view keeps only « Interaction vocale » of the real voice file',()=>{
   const view=live.voiceStyleView(voiceRaw);
   assert.ok(view.startsWith('## Interaction vocale'));assert.ok(view.includes('Une seule question à la fois.'));
   assert.ok(!view.includes('## Calibration'));assert.ok(!view.includes('Historique'));
   assert.equal(live.voiceStyleView('# Contexte\n## Autre\nx'),'');assert.equal(live.voiceStyleView(''),'');
  });

  // --- /claw-live/decision: the voice never releases an answer of its own ---
  await test('a model-only Graph policy becomes evidence-required for the voice (real S24 resolution)',async()=>{
   const text="Qu'est-ce que tu as ajusté récemment ?";const raw=resolution(text);
   const d=await clawLiveDecision(owner(),text,async()=>JSON.parse(JSON.stringify(raw)));
   assert.equal(d.harness.tool_policy,'required');assert.equal(d.harness.voice_policy,'brain_delegation');assert.equal(d.harness.model_tool_policy,'optional');
   assert.equal(d.harness.reason,'model_only_framing');assert.equal(d.decision.type,'REASON');assert.deepEqual(d.voiceFastPath,{version:1,execute:false});
  });
  await test('an already required policy stays required without a model policy trace',async()=>{
   const d=await clawLiveDecision(owner(),'Bonjour Samantha',async()=>JSON.parse(JSON.stringify(resolution('Bonjour Samantha'))));
   assert.equal(d.harness.tool_policy,'required');assert.equal(d.harness.voice_policy,'brain_delegation');assert.equal(Object.hasOwn(d.harness,'model_tool_policy'),false);
  });
  await test('a deterministic route is untouched and still executes without a model',async()=>{
   const canonical={success:true,decision:deterministic.decision_envelope,harness:{tool_policy:'required'}};
   const d=await clawLiveDecision(owner(),'Quel est mon solde ?',async()=>canonical);
   assert.deepEqual(d.voiceFastPath,{version:1,execute:true});assert.equal(Object.hasOwn(d.harness,'voice_policy'),false);
  });
  await test('an unavailable or malformed resolution fails closed to required',async()=>{
   for(const raw of [{success:false,error:'helper_failed'},{harness:'x'},{harness:[]}]){
    const d=await clawLiveDecision(owner(),'raconte-moi une blague',async()=>raw);
    assert.equal(d.harness.tool_policy,'required');assert.equal(d.voiceFastPath.execute,false);
   }
  });

  // --- Rescue path: what the coordinator leaves unresolved goes to the brain ---
  const ticket=Object.freeze({keyId:'k',epoch:'e',clientRunId:'voice-cap-t1',sessionId:'s1',admittedAt:1,expiresAt:2});
  const ctx=(over={})=>({sessionId:'s1',clientRunId:'voice-cap-t1',admission:ticket,assertCurrent:()=>{},...over});
  function clock(){let t=0;return {now:()=>t,sleep:async(ms)=>{t+=ms;}};}
  await test('brain answer within budget: same owner as ask_samantha, spoken word for word',async()=>{
   const calls=[];const states=['running','running','done'];const c=clock();
   const r=await brain.delegateVoiceTurnToBrain("Qu'est-ce que tu as ajusté récemment ?",ctx(),{...c,
    submit:async(...args)=>{calls.push(args);return {success:true,accepted:true,submissionState:'accepted',runId:'run_1',state:'running',result:'Samantha traite la demande.'};},
    status:async()=>{const state=states.shift();return {success:true,runId:'run_1',state,message:'',result:state==='done'?"Rien n'a changé depuis hier.":undefined};}});
   assert.equal(calls.length,1);const [text,session,attachments,options]=calls[0];
   assert.equal(text,"Qu'est-ce que tu as ajusté récemment ?");assert.equal(session,'s1');assert.deepEqual(attachments,[]);
   assert.deepEqual(options,{userText:text,clientRunId:'voice-cap-t1',authority:'owner',admission:ticket,voiceDelegation:true});
   assert.equal(options.admission,ticket,'the turn admission ticket itself, never a new authority');
   assert.equal(r.success,true);assert.equal(r.state,'done');assert.equal(r.source,'samantha_brain');assert.equal(r.text,"Rien n'a changé depuis hier.");
   assert.equal(r.voice.verbatim,"Rien n'a changé depuis hier.");assert.equal(r.runId,'run_1');assert.deepEqual(r.execution,{state:'completed'});
  });
  await test('a run still active at the budget is announced as pending, never claimed',async()=>{
   const c=clock();let polls=0;
   const r=await brain.delegateVoiceTurnToBrain('Fais-moi un résumé de ma semaine',ctx(),{...c,budgetMs:30_000,
    submit:async()=>({success:true,accepted:true,runId:'run_2',state:'running',result:'…'}),status:async()=>{polls++;return {success:true,runId:'run_2',state:'running',message:''};}});
   assert.equal(r.state,'pending');assert.equal(r.text,"Je te l'écris dans la discussion.");assert.equal(r.voice.verbatim,r.text);assert.ok(polls>=50&&polls<=61);
  });
  await test('an immediate canonical result needs no polling',async()=>{
   let polls=0;
   const r=await brain.delegateVoiceTurnToBrain('Quelle heure est-il ?',ctx(),{...clock(),submit:async()=>({success:true,accepted:true,runId:'run_3',state:'done',result:'Il est 1 h 20.'}),status:async()=>{polls++;}});
   assert.equal(polls,0);assert.equal(r.text,'Il est 1 h 20.');
  });
  await test('a refused submission is readable, never an error code',async()=>{
   const r=await brain.delegateVoiceTurnToBrain('Bonjour',ctx(),{...clock(),submit:async()=>({success:false,accepted:false,submissionState:'not_submitted',runId:'',message:'owner_required',result:''}),status:async()=>{throw new Error('no');}});
   assert.equal(r.success,false);assert.equal(r.reason,'owner_required');assert.ok(!r.text.includes('owner_required'));assert.deepEqual(r.execution,{state:'not_submitted'});
  });
  await test('a submission with unknown outcome is never resubmitted nor claimed',async()=>{
   let submits=0;
   const r=await brain.delegateVoiceTurnToBrain('Envoie le message',ctx(),{...clock(),submit:async()=>{submits++;throw new Error('socket hang up');},status:async()=>{throw new Error('no');}});
   assert.equal(submits,1);assert.equal(r.state,'unknown');assert.equal(r.success,false);assert.match(r.text,/Ne rejoue pas cette demande/);
  });
  await test('an expired admission refuses before any submission',async()=>{
   let submits=0;
   await assert.rejects(brain.delegateVoiceTurnToBrain('Bonjour',ctx({assertCurrent:()=>{throw new Error('owner_admission_required');}}),{...clock(),submit:async()=>{submits++;},status:async()=>{}}),/owner_admission_required/);
   assert.equal(submits,0);
  });
  await test('a failed run speaks a readable state, the technical detail stays in the discussion',async()=>{
   const r=await brain.delegateVoiceTurnToBrain('Bonjour',ctx(),{...clock(),submit:async()=>({success:true,accepted:true,runId:'run_4',state:'running',result:''}),
    status:async()=>({success:false,runId:'run_4',state:'failed',message:'gateway_cli_exit_1',result:'Error: gateway_cli_exit_1 at /data/x'})});
   assert.equal(r.state,'failed');assert.ok(!r.text.includes('gateway'));assert.match(r.text,/Le détail est dans la discussion/);
  });
  await test('a long brain answer is kept whole and not imposed word for word',async()=>{
   const long='Voici le détail. '.repeat(60);
   const r=await brain.delegateVoiceTurnToBrain('Explique-moi',ctx(),{...clock(),submit:async()=>({success:true,accepted:true,runId:'r5',state:'done',result:long}),status:async()=>{}});
   assert.equal(r.text,long.trim());assert.equal(r.voice,undefined);
  });
  await test('the capability receipt template never rewrites a brain receipt',async()=>{
   for(const state of ['done','failed']){
    const receipt=await brain.delegateVoiceTurnToBrain('Bonjour',ctx(),{...clock(),submit:async()=>({success:true,accepted:true,runId:'r6',state,result:'Bonjour Amine.'}),status:async()=>{}});
    const spoken=await clawLiveCapability(owner(),{request:'Bonjour'},async()=>receipt,{capture:async()=>({state:'skipped'})});
    assert.equal(spoken.voice.verbatim,receipt.text);assert.ok(!/J'ai compris|Ça n'a pas abouti/.test(spoken.voice.verbatim));
   }
  });

  // --- What the brain receives for a voice turn ---
  await test('the main agent is told the voice surface and gets the canonical voice file',()=>{
   const plain=live.compactOwnerAgentContext({authority:'owner',home});
   const voice=live.compactOwnerAgentContext({authority:'owner',home,voiceDelegation:true});
   assert.ok(!plain.includes('## VOICE_TURN'));assert.ok(!plain.includes('## VOICE_CONTEXT'));
   assert.ok(voice.startsWith(plain),'the canonical owner context is unchanged, voice blocks are appended');
   assert.ok(voice.includes('## VOICE_TURN\nCe tour vient de Samantha Voix.'));assert.ok(voice.includes('## VOICE_CONTEXT\n# Contexte vocal — Amine'));
   assert.ok(voice.includes('## Calibration'));assert.ok(voice.includes('USER_MARKER_PRIVATE')&&voice.includes('HYBRID_MARKER_MEMORY_VIEW'));
   assert.ok(Buffer.byteLength(voice)<=65536);
   assert.equal(live.compactOwnerAgentContext({voiceDelegation:true,home}),'','never without owner authority');
  });
  await test('wiring: /claw-live/capability hands unresolved turns to the brain, the agent client forwards voice delegation',()=>{
   const server=fs.readFileSync(path.join(__dirname,'../src/companion/server.ts'),'utf8');
   const start=server.indexOf('routePath === "/claw-live/capability"'),end=server.indexOf('routePath === "/owner-admission"',start);
   assert.ok(start>0&&end>start);const block=server.slice(start,end);
   assert.match(block,/delegateVoiceTurnToBrain\(text, \{sessionId, clientRunId: String\(body\.clientRunId \|\| ""\), admission: admission\.ticket, assertCurrent\}/);
   assert.match(block,/\{submit: submitIntent, status: getRunStatus\}/);
   assert.ok(!/capabilityBridge\(text, \{execute:true/.test(block),'no second Graph execution of an unresolved voice turn');
   const agent=fs.readFileSync(path.join(__dirname,'../src/companion/openclawAgentClient.ts'),'utf8');
   assert.match(agent,/const canonical=compactOwnerAgentContext\(options\);/);
  });
  console.log(JSON.stringify({passed,failed:0,fixtures:'s24-2026-10-25-voice-brain',live:'not_run (owner voice recipe pending)'}));
 } finally {fs.rmSync(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
