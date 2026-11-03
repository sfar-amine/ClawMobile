// Brain delegation of Samantha Voix (Amine 25/10/2026: « il doit absolument tout déléguer au cerveau »).
// Real S24 captures: fixtures/s24-2026-10-25-voice-brain (SOUL, voice file, operating rules, claw_live resolutions).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const live=require('../dist/companion/clawLive');
const {clawLiveDecision,clawLiveCapability}=require('../dist/companion/clawLiveUnderstanding');
const brain=require('../dist/companion/voiceBrainDelegation');

const FIX=path.join(__dirname,'../fixtures/s24-2026-10-25-voice-brain');
const resolutions=JSON.parse(fs.readFileSync(path.join(FIX,'resolve-claw_live.json'),'utf8'));
let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name);}

const home=fs.mkdtempSync(path.join(os.tmpdir(),'voice-brain-'));
const work=path.join(home,'.openclaw','workspace');
fs.cpSync(path.join(FIX,'s24-workspace'),work,{recursive:true});
// Personal files are never captured: synthetic markers prove what each surface receives.
fs.writeFileSync(path.join(work,'USER.md'),'USER_MARKER_PRIVATE');
fs.writeFileSync(path.join(work,'context','HYBRID_CONTEXT.md'),'# Claw Hybrid Conversation Context — Amine\nHYBRID_MARKER_MEMORY_VIEW\n');
const voiceRaw=fs.readFileSync(path.join(work,'memory','voice','amine.md'),'utf8');

function owner(){return {executeVoiceCapability:(_m,_r,run)=>run()};}
const resolution=(request)=>resolutions.cases.find(c=>c.request===request).resolution;

(async()=>{
 try{
  // --- Gemini Live contract of the Android voice ---
  const android=live.buildClawLiveSetup('gemini-3.8-live',{home,client:'samantha_android'}).setup;
  const prompt=android.systemInstruction.parts[0].text;
  const tools=android.tools[0].functionDeclarations;
  await test('android voice declares ask_samantha first, verbatim and asynchronous',()=>{
   assert.deepEqual(tools.map(t=>t.name),['ask_samantha','clawmobile_capability']);
   const ask=tools[0];assert.equal(ask.behavior,'NON_BLOCKING');assert.deepEqual(Object.keys(ask.parameters.properties),['request']);assert.deepEqual(ask.parameters.required,['request']);
   assert.match(ask.description,/every turn/);
  });
  await test('clawmobile_capability is reserved to answering a needs_clarification receipt',()=>{
   const cap=tools[1];assert.equal(cap.behavior,'BLOCKING');assert.deepEqual(cap.parameters.required,['request','clarificationId']);assert.match(cap.description,/^Only to send/);assert.match(cap.description,/Never for a new request/);
  });
  await test('android instruction delegates every turn and forbids answering alone',()=>{
   assert.match(prompt,/brain delegation v3/);
   assert.match(prompt,/ABSOLUTE RULE: every time Amine speaks, call ask_samantha/);
   assert.match(prompt,/Only exception, social reflexes: .*without any tool and without any fact, number, state, memory, opinion or promise/);
   assert.match(prompt,/« Oui », « non », « d'accord », a choice or any answer to a question are never reflexes: they go to ask_samantha/);
   assert.match(prompt,/Never answer from your own knowledge, from the conversation history or from these instructions/);
   assert.match(prompt,/Never say that something is saved, noted, remembered, done, adjusted, checked or sent unless the returned text says so/);
   assert.match(prompt,/never invoke confidentiality yourself/);
   assert.ok(prompt.includes('contains voice.verbatim, start your spoken answer with exactly that text, word for word'));
   assert.ok(!/Pure conversation|may be answered directly/.test(prompt),'the free-answer loophole is gone');
   assert.ok(prompt.includes('Detect the language actually spoken by Amine on every turn: pass his words in that language, never translated'));
   assert.ok(prompt.includes('The UI locale is French')&&prompt.includes('Never translate French speech into English'));
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

  // --- /claw-live/decision: every turn goes to the brain (ADR 02/11, step 3), outside the closed reflex list ---
  const pay=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/hs3-resolution-slots-shortlist.json'),'utf8')).resolutions.r11;
  await test('every non-reflex turn is Companion-owned and goes to the brain, with no resolver call',()=>{
   // Real S24 requests: model-only framing, a Graph capability, the payment r11 and a deterministic balance read alike.
   for(const text of ["Qu'est-ce que tu as ajusté récemment ?",'Montre-moi ce que tu sais faire',pay.text,'Quel est mon solde ?','raconte-moi une blague']){
    const d=clawLiveDecision(text);
    assert.equal(d.harness.tool_policy,'required');assert.equal(d.harness.evidence_required,true);assert.equal(d.harness.allow_model_only,false);
    // Android VoiceOptionAPolicy.deterministic(): success === true and voiceFastPath {version:1, execute:true} play the waiting clip.
    assert.equal(d.success,true);assert.deepEqual(d.voiceFastPath,{version:1,execute:true,owner:'samantha_brain'});assert.equal(d.decision,undefined,text);
   }
   assert.ok(resolution("Qu'est-ce que tu as ajusté récemment ?"),'real S24 capture still present');
  });
  await test('social reflexes (kept, Amine 25/10) are decided by code and answered by the voice itself',()=>{
   const {voiceReflex}=require('../dist/companion/voiceReflex');
   for(const [text,kind] of [['Bonjour Samantha','greeting'],['Merci beaucoup !','thanks'],['Sam, tu m’entends ?','presence'],['Répète s’il te plaît','repeat'],
     ['Attends une seconde','wait'],['Au revoir Samantha','goodbye'],['Bonsoir, ça va ?','greeting'],['merci, au revoir','thanks'],['Aslema','greeting'],['Thank you','thanks']]){
    assert.equal(voiceReflex(text),kind,text);
    const d=clawLiveDecision(text);
    assert.equal(d.harness.tool_policy,'optional');assert.equal(d.harness.voice_policy,'reflex');assert.deepEqual(d.voiceFastPath,{version:1,execute:false});
   }
   for(const text of ['oui','non',"d'accord",'ok','ok merci','la première','bonjour quel est mon solde orange','merci de vérifier mes factures',
     'répète mes rendez-vous','tu peux me rappeler demain','attends que je te dise','comment va mon compte','',null,'x'.repeat(200)])
    assert.equal(voiceReflex(text),null,String(text));
  });

  // --- Brain delegation of the admitted voice turn ---
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
   assert.equal(r.timing.brainMs,1500,'three polls of 500 ms on the fake clock');
  });
  await test('the voice turn log line carries route and durations only, never the request or the answer',()=>{
   const line=brain.voiceTurnLogLine({state:'done',source:'samantha_brain',text:'Secret answer',timing:{route:'brain',coordinatorMs:812,resolveMs:301,brainMs:2400}},3600);
   assert.equal(line,'[voice-turn] route=brain state=done coordinator_ms=812 resolve_ms=301 brain_ms=2400 total_ms=3600');
   assert.equal(brain.voiceTurnLogLine(null,5),'[voice-turn] route=coordinator state=- coordinator_ms=- resolve_ms=- brain_ms=- total_ms=5');
   assert.ok(!brain.voiceTurnLogLine({state:'Bonjour Amine !'},1).includes('Bonjour'));
  });
  await test('a run still active at the budget is announced as pending, never claimed',async()=>{
   const c=clock();let polls=0;
   const r=await brain.delegateVoiceTurnToBrain('Fais-moi un résumé de ma semaine',ctx(),{...c,budgetMs:30_000,
    submit:async()=>({success:true,accepted:true,runId:'run_2',state:'running',result:'…'}),status:async()=>{polls++;return {success:true,runId:'run_2',state:'running',message:''};}});
   assert.equal(r.state,'pending');assert.equal(r.text,"Je te donne la réponse dès que je l'ai.");assert.equal(r.deferredReadback,undefined);assert.equal(r.voice.verbatim,r.text);assert.ok(polls>=50&&polls<=61);
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
    const spoken=await clawLiveCapability(owner(),{request:'Bonjour'},async()=>receipt);
    assert.deepEqual(spoken,receipt);assert.equal(spoken.voice.verbatim,receipt.text);assert.ok(!/J'ai compris|Ça n'a pas abouti/.test(spoken.voice.verbatim));
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
  // --- Routing: every admitted voice turn goes to the brain, the payment request included (ADR 02/11, step 3) ---
  function router(){
   const seen={submitted:0};
   return {seen,deps:{...clock(),submit:async()=>{seen.submitted++;return {success:true,accepted:true,runId:'rb',state:'done',result:'Réponse du cerveau.'};},status:async()=>{}}};
  }
  await test('every voice turn goes to the brain, never to a Graph execution (real S24 r11 payment included)',async()=>{
   assert.equal(pay.decision.type,'EXECUTE');assert.equal(pay.decision.risk,'transaction');
   for(const text of ["Qu'est-ce que tu as ajusté récemment ?",'Bonjour Samantha',pay.text,'mon solde']){
    const {seen,deps}=router();const r=await brain.routeVoiceTurnToBrain(text,ctx(),deps);
    assert.deepEqual(seen,{submitted:1});assert.equal(r.source,'samantha_brain');
   }
   assert.equal(brain.routeUnresolvedVoiceTurn,undefined);assert.equal(brain.brainTerritory,undefined);
  });
  await test('routing records its route and measured brain duration, with no resolution',async()=>{
   let t=0;const deps={now:()=>t,sleep:async(ms)=>{t+=ms;},submit:async()=>{t+=1200;return {success:true,accepted:true,runId:'rt',state:'done',result:'Rien.'};},status:async()=>{}};
   const r=await brain.routeVoiceTurnToBrain('x',ctx(),deps);
   assert.deepEqual(r.timing,{route:'brain',resolveMs:0,brainMs:1200});
  });
  await test('admission is checked before any effect',async()=>{
   const {seen,deps}=router();
   await assert.rejects(brain.routeVoiceTurnToBrain('x',ctx({assertCurrent:()=>{throw new Error('owner_admission_required');}}),deps),/owner_admission_required/);
   assert.deepEqual(seen,{submitted:0});
  });
  await test('wiring: /claw-live/capability routes every turn to the brain, the agent client forwards voice delegation',()=>{
   const server=fs.readFileSync(path.join(__dirname,'../src/companion/server.ts'),'utf8');
   const start=server.indexOf('routePath === "/claw-live/capability"'),end=server.indexOf('routePath === "/owner-admission"',start);
   assert.ok(start>0&&end>start);const block=server.slice(start,end);
   assert.match(block,/routeVoiceTurnToBrain\(text, \{sessionId, clientRunId: String\(body\.clientRunId \|\| ""\), admission: admission\.ticket, assertCurrent\}/);
   assert.doesNotMatch(block,/capabilityBridge|clawLiveCapabilityTurn/);
   const decision=server.slice(server.indexOf('routePath === "/claw-live/decision"'),start);assert.doesNotMatch(decision,/capabilityBridge/);
   assert.match(block,/submit: submitIntent, status: voiceRunStatus, pollMs: VOICE_RUN_POLL_MS/);
   assert.match(block,/console\.log\(voiceTurnLogLine\(result, Date\.now\(\) - turnStarted\)\);/);
   const agent=fs.readFileSync(path.join(__dirname,'../src/companion/openclawAgentClient.ts'),'utf8');
   assert.match(agent,/const canonical=compactOwnerAgentContext\(options\);/);
  });
  console.log(JSON.stringify({passed,failed:0,fixtures:'s24-2026-10-25-voice-brain',live:'not_run (owner voice recipe pending)'}));
 } finally {fs.rmSync(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
