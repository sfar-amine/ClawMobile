const assert=require('node:assert/strict');
(async()=>{
 const model=require('../dist/modelFastPath'),runs=require('../dist/companion/runs');let calls=0,decision={version:2,type:'REASON',risk:'read',confirmationRequired:false,humanBoundary:null};
 model.runModelFastPath=async(text,options)=>{calls++;assert.equal(options.checkOnly,true);return {status:'miss',decision}};
 let payments=[],confirmations=[];runs.readPaymentRequests=async()=>payments;runs.readOwnerConfirmations=async()=>confirmations;
 const {learningPaymentGuard}=require('../dist/companion/skillLearning');let checks=0;const fail=async(instruction,code,cid)=>{await assert.rejects(()=>learningPaymentGuard(instruction,cid),e=>e.message===code);checks++};
 await learningPaymentGuard('Apprendre la recherche dans une note');checks++;
 for(const instruction of ['finance','money transfer','payer une facture','un achat','carte','wallet','10 USD'])await fail(instruction,'learn_payment_excluded');assert.equal(calls,1);checks++;
 for(const risk of ['payment','financial','transaction','sensitive','destructive','external_send']){decision={version:2,type:'REASON',risk};await fail('Apprendre la recherche','learn_payment_excluded');}
 decision={version:2,type:'REASON',risk:'unknown'};await fail('Apprendre la recherche','learning_guard_unavailable');decision={version:2,type:'REASON'};await fail('Apprendre la recherche','learning_guard_unavailable');
 decision={version:2,type:'REASON',risk:'read'};payments=[{state:'awaiting_owner',originId:'unrelated'}];await fail('Apprendre la recherche','learn_payment_excluded');payments=[];confirmations=[{id:'unrelated',state:'approved'}];await fail('Apprendre la recherche','learn_payment_excluded');
 const text='Apprendre la recherche',hash=require('node:crypto').createHash('sha256').update(text).digest('hex');confirmations=[{id:'mine',state:'approved',intent:{action:{type:'skill.learn',reference:'learn',payloadHash:hash}},proof:{},createdAt:Date.now()-1000,expiresAt:Date.now()+100000}];await learningPaymentGuard(text,'mine');checks++;confirmations[0].intent.action.payloadHash='bad';await fail(text,'learn_payment_excluded','mine');confirmations=[];runs.readPaymentRequests=async()=>{throw Error('corrupt')};await fail(text,'learning_guard_unavailable');
 console.log(JSON.stringify({passed:checks,scope:'synthetic decision v2/canonical guard projections; no S24 capture'}));
})().catch(e=>{console.error(e);process.exitCode=1});
