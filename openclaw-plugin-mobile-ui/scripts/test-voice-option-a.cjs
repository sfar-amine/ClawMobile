const assert=require('node:assert/strict');
const {clawLiveDecision}=require('../dist/companion/clawLiveUnderstanding');
const {buildClawLiveSetup}=require('../dist/companion/clawLive');
let passed=0;
function test(name,run){run();passed++;console.log('PASS '+name);}
(async()=>{
 // ADR 02/11 step 3: no resolver projection decides a voice turn any more; every non-reflex turn goes to the brain.
 test('a balance request goes to the brain with no resolver call',()=>{const result=clawLiveDecision('Quel est mon solde ?');assert.deepEqual(result.voiceFastPath,{version:1,execute:true,owner:'samantha_brain'});assert.equal(result.decision,undefined);});
 const tools=buildClawLiveSetup('gemini-test',{home:'/missing',client:'samantha_android'}).setup.tools[0].functionDeclarations;
 test('ask_samantha is an asynchronous tool with only verbatim request',()=>{const t=tools.find(x=>x.name==='ask_samantha');assert(t);assert.equal(t.behavior,'NON_BLOCKING');assert.deepEqual(Object.keys(t.parameters.properties),['request']);assert.deepEqual(t.parameters.required,['request']);});
 console.log(JSON.stringify({passed,failed:0,qualification:'canonical capture and protocol only; live parity pending Claude'}));
})().catch(e=>{console.error(e);process.exitCode=1});
