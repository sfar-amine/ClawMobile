const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {deterministicLiveDecision,clawLiveDecision,VoiceUnderstandingState}=require('../dist/companion/clawLiveUnderstanding');
const {buildClawLiveSetup}=require('../dist/companion/clawLive');
const source=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/o7-o8-orange-20261010-0941.json'),'utf8'));
const canonical={success:true,decision:source.decision_envelope};let passed=0;
function test(name,run){run();passed++;console.log('PASS '+name);}
(async()=>{
 test('real S24 canonical route is admitted with no model',()=>assert(deterministicLiveDecision(canonical)));
 for(const type of ['CLARIFY','STOP','DEFER'])test(type+' does not execute',()=>assert(!deterministicLiveDecision({...canonical,decision:{...canonical.decision,type}})));
 for(const selected of [{},{deterministic:true},{model_required:false},{deterministic:true,model_required:true}])test('incomplete/model selection fails closed',()=>assert(!deterministicLiveDecision({...canonical,decision:{...canonical.decision,selected}})));
 test('failed resolver never admits',()=>assert(!deterministicLiveDecision({...canonical,success:false})));
 test('top-level selected cannot replace decision owner',()=>assert(!deterministicLiveDecision({success:true,selected:canonical.decision.selected,decision:{type:'EXECUTE'}})));
 test('human boundary survives deterministic admission',()=>{const result={...canonical,decision:{...canonical.decision,risk:'transaction',confirmationRequired:true,humanBoundary:'biometric'}};assert(deterministicLiveDecision(result));assert.equal(result.decision.confirmationRequired,true);});
 const owner={understanding:new VoiceUnderstandingState()};let calls=0;const result=await clawLiveDecision(owner,'Quel est mon solde ?',async()=>{calls++;return canonical});assert.equal(calls,1);assert.deepEqual(result.voiceFastPath,{version:1,execute:true});assert.deepEqual(result.decision,canonical.decision);passed++;
 const tools=buildClawLiveSetup('gemini-test',{home:'/missing',client:'samantha_android'}).setup.tools[0].functionDeclarations;
 test('ask_samantha is a blocking tool with only verbatim request',()=>{const t=tools.find(x=>x.name==='ask_samantha');assert(t);assert.equal(t.behavior,'BLOCKING');assert.deepEqual(Object.keys(t.parameters.properties),['request']);assert.deepEqual(t.parameters.required,['request']);});
 console.log(JSON.stringify({passed,failed:0,qualification:'canonical capture and protocol only; live parity pending Claude'}));
})().catch(e=>{console.error(e);process.exitCode=1});
