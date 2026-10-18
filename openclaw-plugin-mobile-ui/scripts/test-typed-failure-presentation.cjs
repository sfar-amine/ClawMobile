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
 // Fault injection at the existing transport; verifies cause persistence, not merely a renderer helper.
 const helper=path.join(root,'helper.py'),mode=path.join(root,'reply.json');
 fs.writeFileSync(mode,JSON.stringify({outcome:'FAILED',reasonCode:'execution_cancelled',text:'Interrupted',handled:true,presentationDiagnostics:{genericDisplayByCapability:[{capability:'runtime.inventory',renders:2}]}}));
 fs.writeFileSync(helper,`import json\nprint(json.dumps(json.load(open(${JSON.stringify(mode)}))))\n`);
 process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER=helper;
 const {submitIntent}=require('../dist/companion/intent'),runs=require('../dist/companion/runs');
 const result=await submitIntent('test transport cause','f2-test',[],{clientRunId:'f2-propagation'});
 assert.equal(result.state,'failed');assert.equal(result.failure.reasonCode,'execution_cancelled');checks++;
 assert.equal(render.receiptPresentationCounters().genericDisplayRenders,2);checks++;
 const stored=await runs.getRunStatus(result.runId);assert.equal(stored.failure.reasonCode,'execution_cancelled');assert.equal(stored.failure.reason,render.FAILURE_PHRASES.fr.execution_cancelled);checks++;
 await runs.getRunStatus(result.runId);await runs.getRunStatus(result.runId);
 assert.equal(render.receiptPresentationCounters().genericDisplayRenders,2);checks++;
 // The actual helper/dialogue/submit/settlement chain must keep producer prose
 // when an internal code has no renderer-owned translation (Claude #325).
 const ownerReplies=[
  {outcome:'MAINTENANCE',reasonCode:'maintenance',text:'Une mise à jour est en cours. Réessaie dans un instant.'},
  {outcome:'FAILED',reasonCode:'answer_unresolved',text:'Je n’ai pas compris ta réponse. Quel choix souhaites-tu ?'},
  {outcome:'DENIED',reasonCode:'outside_scope',text:'Cette demande dépasse les accès accordés.'},
  {outcome:'FAILED',reasonCode:'no_progress',text:'Je ne peux pas avancer sans la précision demandée.'},
 ];
 for(const [i,reply] of ownerReplies.entries()){
  fs.writeFileSync(mode,JSON.stringify({...reply,handled:true}));
  const actual=await submitIntent('test owner sentence','f2-owner-'+i,[],{clientRunId:'f2-owner-'+i});
  assert.equal(actual.state,'failed');assert.equal(actual.message,reply.text);
  assert.equal(actual.presentation.spoken,reply.text);assert.equal(actual.failure.reason,reply.text);
  assert(require('../dist/companion/voiceUnderstanding').planVoiceSpeech(actual).verbatim.toLocaleLowerCase('fr').includes(reply.text.replace(/[.]+$/,'').toLocaleLowerCase('fr')));
  assert.equal((await runs.getRunStatus(actual.runId)).message,reply.text);checks++;
 }
 // Exact Graph Web row shape (label/value objects) is not HS3 pair rows. Do
 // not relax that guard: the existing Web owner retains its cause and sources.
 const webSource=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/parallel-free/cloud-anonymous-search-20261015.json'))).result.sources[0];
 const web={version:1,operation:'answer',outcome:'failed',provider:'parallel-free',providerAuth:'anonymous',model:null,profile:null,
  sources:[webSource],claims:[],citations:[],metrics:{},error:{code:'web_deadline_exceeded',stage:'synthesis',message:'La recherche n’a pas abouti dans le délai imparti.'},degradations:[]};
 const graphPresentation={...render.fallbackReceiptPresentation(false),status:'error',label:'Recherche Internet',title:'Recherche Internet',spoken:web.error.message,
  rows:[{label:webSource.title,value:webSource.url}],failure:{step:'Recherche Internet',stepId:'synthesis',reason:web.error.message,notDone:{code:'unknown'}}};
 assert.equal(render.readReceiptPresentation(graphPresentation),undefined);checks++;
 fs.writeFileSync(mode,JSON.stringify({outcome:'FAILED',reasonCode:'web_deadline_exceeded',text:'UNTRUSTED HELPER TEXT',handled:true,metadata:{web,presentation:graphPresentation}}));
 const webReply=await submitIntent('test web failure with source','f2-web-cause',[],{clientRunId:'f2-web-cause'});
 assert.equal(webReply.state,'failed');assert(webReply.message.startsWith(web.error.message));
 assert(webReply.message.includes('Sources :'));assert(webReply.message.includes(webSource.title));assert(!webReply.message.includes('UNTRUSTED'));
 assert.equal((await runs.getRunStatus(webReply.runId)).message,webReply.message);checks++;
 for(const bad of [null,{genericDisplayByCapability:[{capability:'access_token',renders:5}]},{genericDisplayByCapability:[{capability:'test',renders:-1}]},{genericDisplayByCapability:[{capability:'test',renders:1.5}]}])render.recordPresentationDiagnostics(bad);
 assert.equal(render.receiptPresentationCounters().genericDisplayRenders,2);checks++;
 render.recordPresentationDiagnostics({genericDisplayByCapability:Array.from({length:32},(_,i)=>({capability:'cap.test'+i,renders:1}))});
 render.recordPresentationDiagnostics({genericDisplayByCapability:Array.from({length:32},(_,i)=>({capability:'cap.more'+i,renders:1}))});
 assert.equal(render.receiptPresentationCounters().genericDisplayByCapability.length,64);assert.equal(render.receiptPresentationCounters().otherGenericDisplayRenders,1);checks++;
 for(const [i,unsafeOwner] of ['Bearer private','otp 1234',JSON.stringify({private:'value'}),'  '+JSON.stringify({private:'value'}),'x'.repeat(241)].entries()){
  const fallback=render.fallbackReceiptPresentation(true,unsafeOwner);assert(render.readReceiptPresentation(fallback));
  assert(!fallback.spoken.includes(unsafeOwner));assert(!fallback.failure.reason.includes(unsafeOwner));
  fs.writeFileSync(mode,JSON.stringify({outcome:'FAILED',reasonCode:'new_provider_failure',text:unsafeOwner,handled:true}));
  const actual=await submitIntent('test unsafe owner phrase','f2-unsafe-'+i,[],{clientRunId:'f2-unsafe-'+i});
  assert.equal(actual.message,fallback.spoken);assert.equal((await runs.getRunStatus(actual.runId)).message,fallback.spoken);
  assert(!JSON.stringify(actual).includes(unsafeOwner));checks++;
 }
 console.log(JSON.stringify({suite:'typed-failure-presentation',checks,producerCodes:emitted.size,locales:2,persisted:true}));
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
