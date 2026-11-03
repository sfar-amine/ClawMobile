const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'f2-cause-'));process.env.OPENCLAW_STATE_DIR=root;
const render=require('../dist/companion/receiptPresentation');
let checks=0;
(async()=>{try{
 const keys=Object.keys(render.FAILURE_PHRASES.fr).sort();
 assert.deepEqual(Object.keys(render.FAILURE_PHRASES.en).sort(),keys);checks++;
 // Collect literal failures from existing producer code, not a second manually curated code list.
 const source=fs.readFileSync(path.join(__dirname,'../src/modelFastPath.ts'),'utf8');
 const emitted=new Set([...source.matchAll(/(?:reason|reasonCode)\s*:\s*["\']([a-z_]+)["\']/g)].map(m=>m[1]));
 for(const m of source.matchAll(/lastError\s*=\s*["\']([a-z_]+)["\']/g))emitted.add(m[1]);
 for(const m of source.matchAll(/\?\s*"(web_deadline_exceeded)"\s*:\s*"([a-z_]+)"/g)){emitted.add(m[1]);emitted.add(m[2]);}
 const dialogue=fs.readFileSync(path.join(__dirname,'../src/dialogueSurface.ts'),'utf8');
 for(const m of dialogue.matchAll(/reasonCode\s*:\s*["\']([a-z_]+)["\']/g))emitted.add(m[1]);
 // The private native owner emits single-quoted codes as well as the
 // TypeScript transport literals. Keep the real producer inventory exhaustive.
 const admission=fs.readFileSync(path.join(__dirname,'../src/nativePulseAdmission.ts'),'utf8');
 for(const m of admission.matchAll(/Error\(["']([a-z_]+)["']/g))emitted.add(m[1]);
 const helperSource=fs.readFileSync(path.join(__dirname,'../../installer/termux-lite/model-fast-path.py'),'utf8');
 const native=helperSource.split('def run_native_pulse(')[1].split('\ndef _b64_json')[0];
 for(const m of native.matchAll(/["']((?:native_pulse_|pulse_confirmation_|native_contract_)[a-z_]+)["']/g))emitted.add(m[1]);
 assert(emitted.size>=9);
 for(const code of emitted){assert(keys.includes(code),`No rendered failure phrase for producer code ${code}`);checks++;}
 const before=render.receiptPresentationCounters().missingFailureCauseRenders;
 for(const locale of ['fr','en'])for(const code of keys){
  const p=render.fastPathFailurePresentation({reasonCode:code},'execution',locale);
  assert.equal(p.failure.reasonCode,code);assert.equal(p.failure.reason,render.FAILURE_PHRASES[locale][code]);
  assert.equal(p.spoken,p.failure.reason);assert(render.readReceiptPresentation(p));checks++;
 }
 assert.equal(render.receiptPresentationCounters().missingFailureCauseRenders,before);checks++;
 const future=render.fastPathFailurePresentation({reasonCode:'new_provider_failure'},'execution');
 assert.equal(future.failure.reasonCode,'new_provider_failure');assert(!future.spoken.includes('new_provider_failure'));
 assert.equal(render.receiptPresentationCounters().missingFailureCauseRenders,before);checks++;
 for(const unsafe of ['Bearer private','access_token','otp 1234']){
  const p=render.fastPathFailurePresentation({reasonCode:unsafe},'execution');assert.equal(p.failure.reasonCode,undefined);assert(!JSON.stringify(p).includes(unsafe));checks++;
 }
 assert.equal(render.receiptPresentationCounters().missingFailureCauseRenders,before+3);checks++;
 // Existing sanitized S24 receipt schema survives unchanged; it does not produce a fallback render.
 const cases=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11c/hs3-presentations-from-captures.json'))).cases;
 const captured=cases.payment_effect_unknown_fr.presentation;
 assert.deepEqual(render.fastPathFailurePresentation({presentation:captured},'execution'),render.readReceiptPresentation(captured));checks++;
 const card={...captured,rows:[['STEG','0,985 DT'],['Total','0,985 DT']]};
 assert.deepEqual(render.readReceiptPresentation(card).rows,card.rows);checks++;
 for(const rows of [[['STEG','Bearer private']],Array(9).fill(['Total','0 DT']),[{label:'STEG',value:'0 DT'}]]){assert.equal(render.readReceiptPresentation({...card,rows}),undefined);checks++;}
 assert.equal(render.receiptPresentationCounters().missingFailureCauseRenders,before+3);checks++;
 // ADR 02/11 « le cerveau partout », step 3: the app no longer runs the coordinator, so no submitIntent chain renders
 // these codes any more; the renderer and its counters stay the single owner for the producers listed above.
 render.recordPresentationDiagnostics({genericDisplayByCapability:[{capability:'runtime.inventory',renders:2}]});
 assert.equal(render.receiptPresentationCounters().genericDisplayRenders,2);checks++;
 // S24 27/10 17:38: a refused interpretation reached a WhatsApp contact as internal jargon.
 // The phrase is for the person who wrote: plain words, no pipeline vocabulary.
 for(const locale of ['fr','en']){
  const phrase=render.FAILURE_PHRASES[locale].host_interpretation_failed;
  assert(!/interpr|admis|admitted|conforme|match/i.test(phrase),phrase);checks++;
 }
 // Native unknown outcomes stay unknown; no translation may claim a zero effect or invite another execution.
 for(const code of ['native_pulse_protocol_required','native_pulse_execution_unknown','native_pulse_handoff_unavailable']){
  const phrase=render.FAILURE_PHRASES.fr[code];
  assert(!/rien n.a été exécuté|aucune.*exécut|réessaie/i.test(phrase));checks++;
  const p=render.fastPathFailurePresentation({reasonCode:code},'execution');assert.equal(p.spoken,phrase);checks++;
 }
 // Exact Graph Web row shape (label/value objects) is not HS3 pair rows. Do not relax that guard.
 const webSource=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/parallel-free/cloud-anonymous-search-20261015.json'))).result.sources[0];
 const webMessage='La recherche n’a pas abouti dans le délai imparti.';
 const graphPresentation={...render.fallbackReceiptPresentation(false),status:'error',label:'Recherche Internet',title:'Recherche Internet',spoken:webMessage,
  rows:[{label:webSource.title,value:webSource.url}],failure:{step:'Recherche Internet',stepId:'synthesis',reason:webMessage,notDone:{code:'unknown'}}};
 assert.equal(render.readReceiptPresentation(graphPresentation),undefined);checks++;
 for(const bad of [null,{genericDisplayByCapability:[{capability:'access_token',renders:5}]},{genericDisplayByCapability:[{capability:'test',renders:-1}]},{genericDisplayByCapability:[{capability:'test',renders:1.5}]}])render.recordPresentationDiagnostics(bad);
 assert.equal(render.receiptPresentationCounters().genericDisplayRenders,2);checks++;
 render.recordPresentationDiagnostics({genericDisplayByCapability:Array.from({length:32},(_,i)=>({capability:'cap.test'+i,renders:1}))});
 render.recordPresentationDiagnostics({genericDisplayByCapability:Array.from({length:32},(_,i)=>({capability:'cap.more'+i,renders:1}))});
 assert.equal(render.receiptPresentationCounters().genericDisplayByCapability.length,64);assert.equal(render.receiptPresentationCounters().otherGenericDisplayRenders,1);checks++;
 for(const unsafeOwner of ['Bearer private','otp 1234',JSON.stringify({private:'value'}),'  '+JSON.stringify({private:'value'}),'x'.repeat(241)]){
  const fallback=render.fallbackReceiptPresentation(true,unsafeOwner);assert(render.readReceiptPresentation(fallback));
  assert(!fallback.spoken.includes(unsafeOwner));assert(!fallback.failure.reason.includes(unsafeOwner));checks++;
 }
 console.log(JSON.stringify({suite:'typed-failure-presentation',checks,producerCodes:emitted.size,locales:2}));
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
