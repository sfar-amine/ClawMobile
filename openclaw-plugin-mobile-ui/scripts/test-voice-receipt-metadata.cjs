// Authored HS3 contract cases plus real S24 decisions/envelopes; no audio qualification.
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const {readVoiceReceiptMetadata:read}=require('../dist/companion/voiceReceiptMetadata');
const {fallbackReceiptPresentation}=require('../dist/companion/receiptPresentation');
let tests=0;function test(name,fn){fn();tests++;}
function receipt(failed=false,locale='fr'){
 const presentation=fallbackReceiptPresentation(failed);
 if(locale==='en')Object.assign(presentation,{locale,label:'Request',title:'Result to verify',spoken:'The result must be verified.',primary:{label:'Done',action:'done'},understood:{capability:null,label:'Request',slots:{}},...(failed?{failure:{step:'Unproven step',reason:'The receipt does not establish the cause.'}}:{})});
 return {presentation};
}
test('recognized info/error are carried without promoting success or effect',()=>{
 for(const failed of [false,true]){const raw=receipt(failed),out=read(raw,'fr');assert.equal(out.presentation.status,failed?'error':'info');assert.equal(out.spoken,raw.presentation.spoken);assert.equal(out.presentation.effect.debited,'unknown');assert.equal(Boolean(out.failure),failed);}
});
test('locale must come from caller and agree with the receipt',()=>{
 assert.ok(read(receipt(false,'en'),'en'));assert.equal(read(receipt(false),'en'),undefined);
 for(const locale of [undefined,null,'ar','tn','fr-FR','unknown',{},true])assert.equal(read(receipt(),locale),undefined);
});
test('arbitrary result JSON and nested metadata never acquire authority',()=>{
 const raw=receipt();assert.equal(read({result:JSON.stringify(raw)},'fr'),undefined);
 assert.equal(read({result:raw,capabilityResult:raw},'fr'),undefined);assert.equal(read(raw.presentation,'fr'),undefined);
});
test('missing and malformed values stay absent',()=>{
 for(const raw of [null,undefined,[],{},'result',7,{presentation:[]},{presentation:{version:1}}])assert.equal(read(raw,'fr'),undefined);
});
test('success and forged negative effects are not recognized',()=>{
 assert.equal(read({presentation:{...receipt().presentation,status:'success'}},'fr'),undefined);
 for(const debited of [false,true,null])assert.equal(read({presentation:{...receipt().presentation,effect:{debited,source:'receipt'}}},'fr'),undefined);
});
test('root progress/clarification/spoken and private unknown fields are not forwarded',()=>{
 const raw={...receipt(),spoken:'untrusted',progress:{steps:[{state:'done'}]},clarification:{question:'untrusted'},private:'private marker',understood:{label:'untrusted'}};
 raw.presentation.private='private marker';const out=read(raw,'fr');
 assert.equal(out.progress,undefined);assert.equal(out.clarification,undefined);assert.notEqual(out.spoken,raw.spoken);assert.equal(out.understood.label,'Demande');assert.ok(!JSON.stringify(out).includes('private marker'));
});
test('sensitive metadata rejected and input remains unchanged',()=>{
 const raw=receipt();raw.presentation.label='owner@example.invalid';assert.equal(read(raw,'fr'),undefined);
 const input=receipt(true),before=JSON.stringify(input);read(input,'fr');assert.equal(JSON.stringify(input),before);
});
test('short explicitly designated OTP and PIN cannot be spoken or rendered',()=>{
 for(const text of ['Votre OTP est 1234','PIN: 9876','Verification code: 12345','Code de vérification : 1234','OTP: ١٢٣٤']){
  for(const field of ['spoken','label','title']){const raw=receipt();raw.presentation[field]=text;assert.equal(read(raw,'fr'),undefined);}
  const primary=receipt();primary.presentation.primary.label=text;assert.equal(read(primary,'fr'),undefined);
  const understood=receipt();understood.presentation.understood.label=text;assert.equal(read(understood,'fr'),undefined);
  const alt=receipt();alt.presentation.alternatives=[{capability:'device.battery',label:text}];assert.equal(read(alt,'fr'),undefined);
  for(const field of ['step','reason']){const failed=receipt(true);failed.presentation.failure[field]=text;assert.equal(read(failed,'fr'),undefined);}
 }
});
test('non-secret short numbers and confirmation instructions remain intact',()=>{
 for(const text of ['Étape 2 terminée','Code HTTP 404','Un code de vérification est nécessaire','Le PIN reste sur le téléphone']){
  const raw=receipt();raw.presentation.spoken=text;assert.equal(read(raw,'fr').spoken,text);
 }
});
test('projection is detached from later source mutations',()=>{
 const raw=receipt(true),out=read(raw,'fr');raw.presentation.spoken='changed';raw.presentation.understood.label='changed';raw.presentation.failure.reason='changed';
 assert.notEqual(out.spoken,'changed');assert.notEqual(out.understood.label,'changed');assert.notEqual(out.failure.reason,'changed');
 out.understood.label='output changed';assert.equal(raw.presentation.understood.label,'changed');
});
test('constant-size projection ignores unrelated volume without owner calls',()=>{
 const raw={...receipt(),history:Array.from({length:50000},()=>({private:'not projected'}))};const start=performance.now();
 for(let i=0;i<1000;i++)assert.ok(read(raw,'fr'));assert.ok(performance.now()-start<1000);
});
console.log(JSON.stringify({suite:'hs6-voice-metadata-preparation',tests,contractualCases:true,realS24Qualification:false,activeTransport:false}));

const {planVoiceReceiptSpeech:plan,isVoiceRealignmentRequest:realign,VOICE_REALIGNMENT_PHRASES_V1:phrases}=require('../dist/companion/voiceReceiptMetadata');
const captures=require('../fixtures/s24-2026-10-11/hs3-resolution-slots-shortlist.json');
test('real S24 decisions select preview independently of model prose',()=>{
 const r=captures.resolutions;
 assert.ok(plan(receipt(),'fr',r.r8.decision).before);
 assert.equal(plan(receipt(),'fr',r.r4.decision).before,undefined);
 for(const confidence of [0,0.79,undefined,NaN])assert.ok(plan(receipt(),'fr',{risk:'read',confidence}).before);
 assert.equal(plan(receipt(),'fr',{risk:'read',confidence:0.8}).before,undefined);
 assert.ok(plan(receipt(),'fr',{type:'CLARIFY',confidence:1}).before);
 assert.equal(plan(receipt(),'fr',{risk:'read',confidence:1,understood:'model invention'}).before,undefined);
});
test('spoken failure contains step and reason, never inferred financial reassurance',()=>{
 const raw=receipt(true);raw.presentation.spoken="Rien n’a été débité.";
 const out=plan(raw,'fr',{risk:'transaction'});
 assert.equal(out.before,'J’ai compris : Demande');
 assert.equal(out.after,'Étape : Étape non établie. La cause n’est pas établie par le reçu.');
 assert.ok(!out.after.includes('débité'));
 assert.equal(plan(receipt(true,'en'),'en',{}).after,'Step: Unproven step. The receipt does not establish the cause.');
});
test('real terminal envelopes do not masquerade as qualified voice presentations',()=>{
 const raw=require('../fixtures/s24-2026-10-11/hs3-terminal-receipts.json');
 for(const item of Object.values(raw.families))assert.equal(plan(item.receipt?.envelope,'fr',{}),undefined);
});
test('authored FR EN derja correction gestures expire at two minutes',()=>{
 for(const text of Object.values(phrases).flat()){
  assert.ok(realign(text,1000,121000));assert.ok(!realign(text,1000,121001));
 }
 assert.ok(realign(' Non, c’est pas ça ! ',1000,1001));
 assert.ok(realign('Non c’est pas ça!',1000,1001));
 for(const text of ['non','no','recharge non c’est pas ça','non c’est pas ça puis paie',null])assert.equal(realign(text,1000,1001),false);
 assert.equal(realign("non c'est pas ça",1000,999),false);
});


const {renderFastVoiceResult}=require('../dist/companion/voiceRelay');
test('relay speaks canonical terminal failure without reading model prose',()=>{
 const raw=receipt(true);raw.result='Model says successful payment';
 assert.equal(renderFastVoiceResult(raw),plan(raw,'fr',{}).after);
 assert.equal(renderFastVoiceResult({result:raw}),null);
});

console.log(JSON.stringify({suite:'hs6-voice-speech-plan',tests,fixtures:'S24 core #129 resolutions/terminal envelopes',relayTerminalConnected:true,realS24AudioQualification:false}));
