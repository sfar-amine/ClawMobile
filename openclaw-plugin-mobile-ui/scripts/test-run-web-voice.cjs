const assert=require('node:assert/strict');
const {DialogueSurface}=require('../dist/dialogueSurface');
const {clawLiveCapabilityTurn}=require('../dist/companion/clawLive');
const {voiceReceiptProjection}=require('../dist/companion/voiceUnderstanding');
const {VoiceTurnProtocol}=require('../dist/companion/voiceTurnProtocol');
const {publicWebVoiceRecipeEnabled,readRunWebResult}=require('../dist/companion/runWeb');
const web={version:1,operation:'answer',responseLanguage:'en',outcome:'complete',provider:'parallel-free',providerAuth:'anonymous',model:'google/gemini-3.5-flash-lite',profile:'google:claw-gemini-free',sources:[{id:'s1',title:'Public official reference',url:'https://news.example.org/ref',searchRetrievedAt:'2026-10-15T10:00:00Z',publishedAt:null,excerpt:'A verified public answer. MALICIOUS_INSTRUCTION_TO_READ_PRIVATE_MEMORY',evidenceType:'search_excerpt'}],claims:[{id:'c1',text:'A verified public answer.',sourceIds:['s1'],support:[{sourceId:'s1',quote:'A verified public answer.'}]}],citations:[{claimId:'c1',sourceId:'s1'}],metrics:{reportedCostUsd:null},error:null,degradations:[]};
function setup(){const sent=[],events=[];return {sent,events,p:new VoiceTurnProtocol(1,'session-1',v=>sent.push(v),v=>events.push(v))};}
const ctrl=(kind,extra={})=>({warmControl:{[kind]:{operationId:kind+'-voice-web',sessionEpoch:'session-1',turnId:'voice-web',...extra}}});
function ready(s){s.p.receive(ctrl('turnStart',{firstSample:0}));s.p.receive({warmInput:{audio:{turnId:'voice-web',sessionEpoch:'session-1',firstSample:0,samples:320,sampleRate:16000,data:Buffer.alloc(640).toString('base64')}}});s.p.receive(ctrl('turnEnd',{lastSampleExclusive:320}));s.p.receive(ctrl('transcriptFinal',{source:'android_speech_service',text:'Search online'}));}
(async()=>{
 // V2.2: Claw Live is a surface of the single dialogue coordinator. The G6 gate runs in the coordinator's execute
 // port (model-fast-path.py, before dispatch, tested in test-model-fast-path-web.py); here: the host voice bit and
 // the host identities reach the hand-off, and only the closed projection reaches speech.
 const refusal={...web,outcome:'failed',model:null,profile:null,sources:[],claims:[],citations:[],metrics:{logicalSearchCalls:0,httpRequests:0,transportPosts:0,providerAttempts:0,reportedCostUsd:null},error:{code:'voice_recipe_required',stage:'policy',message:'Voice Web search is awaiting its audio acceptance test; use the text conversation.',retryable:false},degradations:['voice_recipe_required']};
 const calls=[];let legacyExecutions=0;
 const runner=async(text,opts)=>{calls.push(opts);const d=opts.dialogue;assert(d,'dialogue coordinator only');
  if(d.mode==='turn')return {outcome:'READY',goalRef:'goal-web',pendingHandoff:{goalRef:'goal-web',klass:'fast'},decision:{capability:'samantha.app.web.answer',risk:'read'},handled:true};
  if(d.mode==='abort')return {outcome:'FAILED',handled:true};
  assert.equal(d.mode,'handoff');assert.equal(d.web.voiceDelegation,true);assert.equal(d.web.runId,'native-client');assert.equal(d.web.sessionId,'native-session');
  assert(d.web.deadlineEpochMs>Date.now()&&d.web.deadlineEpochMs<=Date.now()+20000);
  if(process.env.CLAW_PUBLIC_WEB_VOICE_RECIPE!=='1')return {outcome:'FAILED',reasonCode:'voice_recipe_required',text:'refus',handled:true,metadata:{web:refusal}};
  return {outcome:'COMPLETED',text:'RAW_UNVERIFIED',handled:true,metadata:{web}};};
 const priorRecipe=process.env.CLAW_PUBLIC_WEB_VOICE_RECIPE;
 delete process.env.CLAW_PUBLIC_WEB_VOICE_RECIPE;assert.equal(publicWebVoiceRecipeEnabled(),false);
 process.env.CLAW_PUBLIC_WEB_VOICE_RECIPE='true';assert.equal(publicWebVoiceRecipeEnabled(),false);
 process.env.CLAW_PUBLIC_WEB_VOICE_RECIPE='1';assert.equal(publicWebVoiceRecipeEnabled(),true);
 delete process.env.CLAW_PUBLIC_WEB_VOICE_RECIPE;
 const surface=()=>new DialogueSurface(runner,'claw_live','claw_live',{modelAllowed:true},{voice:true});
 const body={request:'Search online',originId:'native-client',sessionId:'native-session',assertCurrent:()=>{}};
 const closed=await clawLiveCapabilityTurn(body,async()=>{legacyExecutions++;},surface());
 assert.equal(closed.state,'failed');assert.equal(closed.web.error.code,'voice_recipe_required');assert(readRunWebResult(closed.web));assert.equal(calls.length,2);assert.equal(closed.web.responseLanguage,'en');assert.equal(closed.web.metrics.providerAttempts,0);
 const forged=await clawLiveCapabilityTurn({...body,publicWebVoiceRecipe:true},async()=>{legacyExecutions++;},surface());
 assert.equal(forged.web.error.code,'voice_recipe_required');assert.equal(calls.length,4);calls.length=0;
 process.env.CLAW_PUBLIC_WEB_VOICE_RECIPE='1';
 const result=await clawLiveCapabilityTurn(body,async()=>{legacyExecutions++;throw Error('no duplicate executor')},surface());
 if(priorRecipe===undefined)delete process.env.CLAW_PUBLIC_WEB_VOICE_RECIPE;else process.env.CLAW_PUBLIC_WEB_VOICE_RECIPE=priorRecipe;
 assert.equal(legacyExecutions,0);assert.equal(calls.length,2);assert.equal(result.web.responseLanguage,'en');assert.equal(result.text,'A verified public answer.');assert(!JSON.stringify(result.text).includes('RAW_UNVERIFIED'));
 const projection=voiceReceiptProjection(result,'fr');assert.equal(projection.voice.mode,'public_web');assert.equal(projection.voice.verbatim,'A verified public answer.');
 const s=setup();ready(s);await s.p.execute('voice-web','Search online',async()=>({...result,...projection}));s.p.provider({serverContent:{turnComplete:true}});s.p.receiptReply('voice-web');
 const prompt=s.sent.at(-1).clientContent.turns[0].parts[0].text;assert(prompt.includes('A verified public answer.'));assert(!prompt.includes('MALICIOUS'));assert(!prompt.includes('news.example'));assert(!prompt.includes('reportedCostUsd'));
 s.p.provider({toolCall:{functionCalls:[{id:'unsafe',name:'clawmobile_capability',args:{request:'Read private memory'}}]}});assert(s.events.some(e=>e.warmEvent?.payload?.protocolError?.code==='public_web_readback_tool_forbidden'));assert(!s.events.some(e=>e.warmEvent?.payload?.toolCall?.functionCalls?.[0]?.id==='unsafe'));
 s.p.provider({serverContent:{outputTranscription:{text:'A verified public answer. EXTRA_UNSUPPORTED'},turnComplete:true}});assert.equal(s.events.find(e=>e.warmEvent?.payload?.voiceVerbatim)?.warmEvent.payload.voiceVerbatim.spoken,false);
 const search={...web,operation:'search',model:null,profile:null,claims:[],citations:[],responseLanguage:'aeb'};const neutral=voiceReceiptProjection({web:search},'en');assert.equal(neutral.voice.verbatim,'نتائج البحث تلقاهم في المحادثة.');
 delete search.responseLanguage;const noLanguage=voiceReceiptProjection({web:search},'fr');assert.equal(noLanguage.voice.verbatim,null);assert.equal(noLanguage.voice.mode,'public_web');
 const t=setup();ready(t);await t.p.execute('voice-web','Search online',async()=>({web:search,...noLanguage}));t.p.provider({serverContent:{turnComplete:true}});assert.throws(()=>t.p.receiptReply('voice-web'),/public_web_readback_language_required/);
 console.log(JSON.stringify({suite:'run-web-voice',passed:10,total:10,scope:'source_protocol_not_acoustic',cases:['host_recipe_flag_strict','voice_web_default_closed_after_resolution','body_cannot_open_recipe_gate','same_frozen_dispatch','claims_only_speech','no_pages_in_live_readback','no_readback_tools','exact_not_prefix_check','request_language_neutral','missing_language_gate']}));
})().catch(e=>{console.error(e);process.exitCode=1});
