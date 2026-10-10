const assert=require('node:assert/strict');
(async()=>{
 const model=require('../dist/modelFastPath'),runs=require('../dist/companion/runs');let calls=0,decision={version:2,type:'REASON',risk:'read',confirmationRequired:false,humanBoundary:null};
 model.runModelFastPath=async(text,options)=>{calls++;assert.equal(options.checkOnly,true);assert.equal(options.checkBudgetMs,1000);return {status:'miss',decision}};
 let payments=[],confirmations=[];runs.readPaymentRequests=async()=>payments;runs.readOwnerConfirmations=async()=>confirmations;
 const {learningPaymentGuard}=require('../dist/companion/skillLearning');let checks=0;const fail=async(instruction,code,cid)=>{await assert.rejects(()=>learningPaymentGuard(instruction,cid),e=>e.message===code);checks++};
 await learningPaymentGuard('Apprendre la recherche dans une note');checks++;
 for(const instruction of ['finance','money transfer','payer une facture','un achat','carte','wallet','10 USD','Recharger mon forfait Orange','faire une recharge Ooredoo','compte bancaire','top-up','invoice','purchase'])await fail(instruction,'learn_payment_excluded');assert.equal(calls,1);checks++;
 for(const risk of ['payment','financial','transaction','sensitive','destructive','external_send']){decision={version:2,type:'REASON',risk};await fail('Apprendre la recherche','learn_payment_excluded');}
 decision={version:2,type:'REASON',risk:'unknown'};await fail('Apprendre la recherche','learning_guard_unavailable');decision={version:2,type:'REASON'};await fail('Apprendre la recherche','learning_guard_unavailable');
 decision={version:2,type:'REASON',risk:'read'};payments=[{state:'awaiting_owner',originId:'unrelated'}];await fail('Apprendre la recherche','learn_payment_excluded');payments=[];confirmations=[{id:'unrelated',state:'approved'}];await fail('Apprendre la recherche','learn_payment_excluded');
 const text='Apprendre la recherche',hash=require('node:crypto').createHash('sha256').update(text).digest('hex');confirmations=[{id:'mine',state:'approved',intent:{action:{type:'skill.learn',reference:'learn',payloadHash:hash}},proof:{},createdAt:Date.now()-1000,expiresAt:Date.now()+100000}];await learningPaymentGuard(text,'mine');checks++;confirmations[0].intent.action.payloadHash='bad';await fail(text,'learn_payment_excluded','mine');confirmations=[];runs.readPaymentRequests=async()=>{throw Error('corrupt')};await fail(text,'learning_guard_unavailable');
 // Canonical non-lexical payment refusal must occur before any run/confirmation effect.
 runs.readPaymentRequests=async()=>[];decision={version:2,type:'REASON',risk:'payment'};
 const mod=require('../dist/companion/skillLearning');let reserved=0,consumed=0;
 const body={operationId:'nonlexical-payment',confirmationId:'12345678-1234-4123-8123-123456789abc',instruction:'Effectue cette opération pour le service'};
 await assert.rejects(()=>mod.learnSkill(body,{guard:mod.learningPaymentGuard,existing:async()=>null,reserve:async()=>{reserved++;throw Error('must not reserve')},confirmation:{status:async()=>{consumed++;throw Error('must not inspect/consume')}},submit:async()=>{throw Error('must not submit')}}),e=>e.message==='learn_payment_excluded');checks++;
 assert.equal(reserved,0);assert.equal(consumed,0);checks+=2;
 // Real existing check-only helper is killed at the opt-in total budget, never dispatched.
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'r8-guard-budget-'));
 const helper=path.join(dir,'helper.py');await fs.writeFile(helper,'import time\ntime.sleep(3)\nprint("{}")\n');
 const owner=require('../dist/modelFastPath');delete require.cache[require.resolve('../dist/modelFastPath')];const actual=require('../dist/modelFastPath');
 const started=performance.now(),bounded=await actual.runModelFastPath('Safe fixture',{helperPath:helper,checkOnly:true,checkBudgetMs:1000});
 assert.equal(bounded.reason,'check_budget_exceeded');assert(performance.now()-started<1400);checks+=2;
 const invalid=await actual.runModelFastPath('Must not dispatch',{helperPath:helper,checkBudgetMs:1000});assert.equal(invalid.reason,'invalid_check_budget');checks++;
 model.runModelFastPath=actual.runModelFastPath;process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER=helper;
 const slowBody={...body,operationId:'guard-budget-no-run'};const beforeReserved=reserved,beforeConsumed=consumed;
 const began=performance.now();await assert.rejects(()=>mod.learnSkill(slowBody,{guard:mod.learningPaymentGuard,existing:async()=>null,reserve:async()=>{reserved++;throw Error('must not reserve')},confirmation:{status:async()=>{consumed++;throw Error('must not consume')}}}),e=>e.message==='learning_guard_budget_exceeded');
 assert(performance.now()-began<1400);assert.equal(reserved,beforeReserved);assert.equal(consumed,beforeConsumed);checks+=4;
 delete process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER;
 await fs.rm(dir,{recursive:true,force:true});
 console.log(JSON.stringify({passed:checks,scope:'synthetic decision v2/canonical guard projections; no S24 capture'}));
})().catch(e=>{console.error(e);process.exitCode=1});
