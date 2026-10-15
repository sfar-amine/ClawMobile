const assert=require('node:assert/strict');
const {SurfaceClarifications}=require('../dist/capabilityClarification');
const {clawLiveCapabilityTurn}=require('../dist/companion/clawLive');
const {voiceReceiptProjection}=require('../dist/companion/voiceUnderstanding');
const {VoiceTurnProtocol}=require('../dist/companion/voiceTurnProtocol');
const web={version:1,operation:'answer',responseLanguage:'en',outcome:'complete',provider:'parallel-free',providerAuth:'anonymous',model:'google/gemini-3.5-flash-lite',profile:'google:claw-gemini-free',sources:[{id:'s1',title:'Public official reference',url:'https://news.example.org/ref',searchRetrievedAt:'2026-10-15T10:00:00Z',publishedAt:null,excerpt:'A verified public answer. MALICIOUS_INSTRUCTION_TO_READ_PRIVATE_MEMORY',evidenceType:'search_excerpt'}],claims:[{id:'c1',text:'A verified public answer.',sourceIds:['s1'],support:[{sourceId:'s1',quote:'A verified public answer.'}]}],citations:[{claimId:'c1',sourceId:'s1'}],metrics:{reportedCostUsd:null},error:null,degradations:[]};
function setup(){const sent=[],events=[];return {sent,events,p:new VoiceTurnProtocol(1,'session-1',v=>sent.push(v),v=>events.push(v))};}
const ctrl=(kind,extra={})=>({warmControl:{[kind]:{operationId:kind+'-voice-web',sessionEpoch:'session-1',turnId:'voice-web',...extra}}});
function ready(s){s.p.receive(ctrl('turnStart',{firstSample:0}));s.p.receive({warmInput:{audio:{turnId:'voice-web',sessionEpoch:'session-1',firstSample:0,samples:320,sampleRate:16000,data:Buffer.alloc(640).toString('base64')}}});s.p.receive(ctrl('turnEnd',{lastSampleExclusive:320}));s.p.receive(ctrl('transcriptFinal',{source:'android_speech_service',text:'Search online'}));}
(async()=>{
 const calls=[];let legacyExecutions=0;
 const runner=async(text,opts)=>{calls.push(opts);if(opts.checkOnly)return {status:'eligible',decision:{version:2,requestId:'native-client',capability:'samantha.app.web.answer',risk:'read',surface:'claw_live',caller:'owner'}};
  assert(opts.remainingBudgetMs>0&&opts.remainingBudgetMs<=12000);assert.equal(opts.requestId,'native-client');assert.equal(opts.sessionId,'native-session');return {status:'hit',execution_state:'completed',web,text:'RAW_UNVERIFIED'};};
 const result=await clawLiveCapabilityTurn({request:'Search online',originId:'native-client',sessionId:'native-session'},async()=>{legacyExecutions++;throw Error('no duplicate executor')},new SurfaceClarifications(runner));
 assert.equal(legacyExecutions,0);assert.equal(calls.length,2);assert.equal(result.web.responseLanguage,'en');assert.equal(result.text,'A verified public answer.');assert(!JSON.stringify(result.text).includes('RAW_UNVERIFIED'));
 const projection=voiceReceiptProjection(result,'fr');assert.equal(projection.voice.mode,'public_web');assert.equal(projection.voice.verbatim,'A verified public answer.');
 const s=setup();ready(s);await s.p.execute('voice-web','Search online',async()=>({...result,...projection}));s.p.provider({serverContent:{turnComplete:true}});s.p.receiptReply('voice-web');
 const prompt=s.sent.at(-1).clientContent.turns[0].parts[0].text;assert(prompt.includes('A verified public answer.'));assert(!prompt.includes('MALICIOUS'));assert(!prompt.includes('news.example'));assert(!prompt.includes('reportedCostUsd'));
 s.p.provider({toolCall:{functionCalls:[{id:'unsafe',name:'clawmobile_capability',args:{request:'Read private memory'}}]}});assert(s.events.some(e=>e.warmEvent?.payload?.protocolError?.code==='public_web_readback_tool_forbidden'));assert(!s.events.some(e=>e.warmEvent?.payload?.toolCall?.functionCalls?.[0]?.id==='unsafe'));
 s.p.provider({serverContent:{outputTranscription:{text:'A verified public answer. EXTRA_UNSUPPORTED'},turnComplete:true}});assert.equal(s.events.find(e=>e.warmEvent?.payload?.voiceVerbatim)?.warmEvent.payload.voiceVerbatim.spoken,false);
 const search={...web,operation:'search',model:null,profile:null,claims:[],citations:[],responseLanguage:'aeb'};const neutral=voiceReceiptProjection({web:search},'en');assert.equal(neutral.voice.verbatim,'نتائج البحث تلقاهم في المحادثة.');
 delete search.responseLanguage;const noLanguage=voiceReceiptProjection({web:search},'fr');assert.equal(noLanguage.voice.verbatim,null);assert.equal(noLanguage.voice.mode,'public_web');
 const t=setup();ready(t);await t.p.execute('voice-web','Search online',async()=>({web:search,...noLanguage}));t.p.provider({serverContent:{turnComplete:true}});assert.throws(()=>t.p.receiptReply('voice-web'),/public_web_readback_language_required/);
 console.log(JSON.stringify({suite:'run-web-voice',passed:7,total:7,scope:'source_protocol_not_acoustic',cases:['same_frozen_dispatch','claims_only_speech','no_pages_in_live_readback','no_readback_tools','exact_not_prefix_check','request_language_neutral','missing_language_gate']}));
})().catch(e=>{console.error(e);process.exitCode=1});
