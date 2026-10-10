const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'h6-pattern-'));process.env.OPENCLAW_WORKSPACE=root;process.env.OPENCLAW_STATE_DIR=root;
 const {AUTOMATION_PAYMENT_PATTERN:pattern,protectedPayment}=require('../dist/companion/automations');
 const exclusion='\\bpay(?!s(?:age)?(?![\\p{L}\\p{N}_]))';assert.ok(pattern.source.includes(exclusion));
 const before=new RegExp(pattern.source.replace(exclusion,'\\bpay'),pattern.flags);
 const positive=['payer la facture STEG','recharge ooredoo','acheter un ticket','top-up orange','pay electricity bill','régler 50 TND','payer avec Maxit','virement 100 EUR','OTP carte bancaire','recharge','top-up','invoice','purchase','10 USD','compte bancaire','carte','payer','paiement','pay','payment','paye','payroll','payable','payee','payload','paysan','paysages','paysé','pays_1','PAYMENT','pays et carte','paysage avec recharge'];
 const negative=['pays','paysage'];
 for(const text of positive){assert.equal(before.test(text),true,'baseline '+text);assert.equal(protectedPayment(text),true,'must stay protected '+text);}
 for(const text of negative){assert.equal(before.test(text),true);assert.equal(protectedPayment(text),false);assert.equal(protectedPayment(text.toUpperCase()),false);assert.equal(protectedPayment('décrire le '+text+' local'),false);}
 const dir=path.join(root,'skills','demo');await fs.mkdir(dir,{recursive:true});
 const markdown=text=>'---\nname: demo\ndescription: '+text+'\n---\nInspect a local document\n';
 await fs.writeFile(path.join(dir,'SKILL.md'),markdown('Inspect a local document'));
 let ownerCalls=0,trials=0;
 const capture=require('../fixtures/s24-2026-10-10/gateway/skills.status.json');
 require('../dist/companion/openclawAgentClient').callOpenClawGateway=async(method)=>{ownerCalls++;assert.equal(method,'skills.status');return {...capture.response,skills:[...capture.response.skills,{...capture.response.skills[0],name:'demo',filePath:path.join(dir,'SKILL.md'),baseDir:dir,skillKey:'demo-canonical',disabled:false}]};};
 require('../dist/companion/intent').submitIntent=async()=>{trials++;throw Error('trial must never be called');};
 const api=require('../dist/companion/skillControl');
 try{
  for(const [i,instruction]of positive.entries())await assert.rejects(api.changeSkill('demo','try',{operationId:'h6-positive-'+i,instruction}),e=>e.message==='protected_skill'&&e.statusCode===409);
  assert.equal(ownerCalls,0,'shared P2-b guard stops before owner');assert.equal(trials,0);
  for(const text of negative){await fs.writeFile(path.join(dir,'SKILL.md'),markdown('Décrire le '+text));const detail=await api.skillControlDetail('demo');assert.notEqual(detail.risk,'high');assert.equal(detail.activationAvailable,true);assert.equal(detail.tryAvailable,true);}
  // H6 does not change the structural-payload issue tracked separately for E1.
  assert.equal(protectedPayment({payload:{kind:'agentTurn',message:'hello'}}),true);
  console.log(JSON.stringify({suite:'H6-shared-payment-boundary',passed:true,preservedPositiveCases:positive.length,allowedWords:negative,ownerCallsForProtectedTrials:0,trialEffects:trials,realFixture:'gateway/skills.status.json'}));
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
