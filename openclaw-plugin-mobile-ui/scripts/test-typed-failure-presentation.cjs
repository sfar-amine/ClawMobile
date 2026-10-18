const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'f2-cause-'));process.env.OPENCLAW_STATE_DIR=root;
const render=require('../dist/companion/receiptPresentation');
let checks=0;
(async()=>{try{
 const keys=Object.keys(render.FAILURE_PHRASES.fr).sort();
 assert.deepEqual(Object.keys(render.FAILURE_PHRASES.en).sort(),keys);checks++;
 // Collect literal failures from existing producer code, not a second manually curated code list.
 const source=fs.readFileSync(path.join(__dirname,'../src/modelFastPath.ts'),'utf8');
 const emitted=new Set([...source.matchAll(/reason\s*:\s*"([a-z_]+)"/g)].map(m=>m[1]));
 for(const m of source.matchAll(/lastError\s*=\s*"([a-z_]+)"/g))emitted.add(m[1]);
 for(const m of source.matchAll(/\?\s*"(web_deadline_exceeded)"\s*:\s*"([a-z_]+)"/g)){emitted.add(m[1]);emitted.add(m[2]);}
 const dialogue=fs.readFileSync(path.join(__dirname,'../src/dialogueSurface.ts'),'utf8');
 for(const m of dialogue.matchAll(/reasonCode\s*:\s*"([a-z_]+)"/g))emitted.add(m[1]);
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
 assert.equal(future.failure.reasonCode,'new_provider_failure');assert.match(future.spoken,/new_provider_failure/);
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
 // Fault injection at the existing transport; verifies cause persistence, not merely a renderer helper.
 const helper=path.join(root,'helper.py');fs.writeFileSync(helper,`import json\nprint(json.dumps({'outcome':'FAILED','reasonCode':'execution_cancelled','text':'Interrupted','handled':True}))\n`);
 process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER=helper;
 const {submitIntent}=require('../dist/companion/intent'),runs=require('../dist/companion/runs');
 const result=await submitIntent('test transport cause','f2-test',[],{clientRunId:'f2-propagation'});
 assert.equal(result.state,'failed');assert.equal(result.failure.reasonCode,'execution_cancelled');checks++;
 const stored=await runs.getRunStatus(result.runId);assert.equal(stored.failure.reasonCode,'execution_cancelled');assert.equal(stored.failure.reason,render.FAILURE_PHRASES.fr.execution_cancelled);checks++;
 console.log(JSON.stringify({suite:'typed-failure-presentation',checks,producerCodes:emitted.size,locales:2,persisted:true}));
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
