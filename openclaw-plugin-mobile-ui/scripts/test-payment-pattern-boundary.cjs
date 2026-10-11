const assert=require('node:assert/strict');
(async()=>{
 // Synthetic canonical decision outcomes: vocabulary is never qualification.
 const model=require('../dist/modelFastPath');let calls=0,decision={version:2,type:'REASON',risk:'read'};
 model.runModelFastPath=async(text,options)=>{calls++;assert.equal(options.checkOnly,true);assert.equal(options.checkBudgetMs,1000);return {status:'miss',decision};};
 const api=require('../dist/companion/automations');
 const words=['pays','paysage','paiement','recharge','bank','invoice','purchase','payload','payroll','paysan','carte','OTP','35 EUR'];
 for(const word of words){
  assert.equal(await api.jobIntentProtection({name:word,description:word,payload:{kind:'agentTurn',message:'Describe '+word+' in the document'}}),'safe');
  assert.equal(api.protectedPayment({...decision,note:word}),false);
 }
 assert.equal(calls,words.length,'one canonical resolution per selected job');
 for(const risk of ['transaction','external_send','sensitive','destructive','payment']){
  decision={version:2,type:'EXECUTE',risk};assert.equal(await api.protectedJob({name:'Ordinary task',payload:{kind:'agentTurn',message:'Proceed with this operation'}}),true);
 }
 decision={version:2,type:'REASON',risk:'read',selected:{risk:'transaction'}};assert.equal(api.resolvedIntentProtection(decision),'protected');
 for(const decision of [null,{},'paiement',{version:2,type:'REASON'},{version:2,type:'REASON',risk:'unknown'}])assert.equal(api.resolvedIntentProtection(decision),'unavailable');
 for(const type of ['CLARIFY','STOP'])assert.equal(api.protectedPayment({version:2,type,risk:'read'}),true);
 const capture=require('../fixtures/s24-2026-10-11b/e1/cron-lifecycle.json');const captured=capture.steps.find(row=>row.method==='cron.get'&&row.exit===0).response;
 decision={version:2,type:'REASON',risk:'read'};assert.equal(await api.jobIntentProtection(captured),'safe','real S24 payload shape, synthetic resolved read');
 const before=calls;assert.equal(await api.jobIntentProtection({name:'safe',risk:'read'}),'unavailable');assert.equal(calls,before,'raw client metadata is never authority');
 decision={version:2,type:'REASON',risk:'read'};assert.equal(await api.jobIntentProtection({payload:{kind:'systemEvent',text:'Read the payment policy'}}),'safe');
 console.log(JSON.stringify({suite:'H6-resolved-intent-boundary',passed:true,allowedWords:words.length,scope:'synthetic decision v2; no S24 qualification'}));
})().catch(e=>{console.error(e);process.exitCode=1});
