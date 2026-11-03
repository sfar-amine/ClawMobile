const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {publicDecision}=require('../dist/companion/receiptPresentation');
const {responseLanguageInstruction,submitToOpenClawAgent}=require('../dist/companion/openclawAgentClient');
const {clawLiveCapability}=require('../dist/companion/clawLiveUnderstanding');

const base={type:'REASON',capability:null,intent:null,target:null,risk:'read',confirmationRequired:false,parameters:{}};
for(const language of ['fr','en','tn']){
  const projected=publicDecision({...base,responseLanguage:language});
  assert.equal(projected.responseLanguage,language);
  assert.ok(responseLanguageInstruction(language));
}
assert.equal(publicDecision({...base,responseLanguage:'de'}).responseLanguage,undefined);
assert.equal(responseLanguageInstruction(undefined),'');
assert.match(responseLanguageInstruction('tn'),/Tunisian derja written in arabizi/);
assert.match(responseLanguageInstruction('en'),/request language, independent of the phone UI language/);
assert.match(responseLanguageInstruction('fr'),/langue vient de la demande/);
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'n4-language-')),out=path.join(dir,'params.json'),cli=path.join(dir,'openclaw');
  fs.writeFileSync(cli,'#!/usr/bin/env python3\nimport json,os,sys\np=json.loads(sys.argv[sys.argv.index("--params")+1])\nopen(os.environ["N4_PARAMS"],"w").write(json.dumps(p))\nprint(json.dumps({"runId":p["idempotencyKey"],"status":"accepted"}))\n');fs.chmodSync(cli,0o700);
  process.env.CLAWMOBILE_OPENCLAW_BIN=cli;process.env.N4_PARAMS=out;
  await submitToOpenClawAgent('my facture STEG chnowa fiha','n4-run','n4-session',{responseLanguage:'tn'});
  const params=JSON.parse(fs.readFileSync(out));
  assert.equal(params.message,'[companion-session:n4-session]\nmy facture STEG chnowa fiha');
  assert.match(params.extraSystemPrompt,/Tunisian derja written in arabizi/);
  assert.ok(!/uiLocale/.test(params.extraSystemPrompt));
  // ADR 02/11 step 3: Claw Live turns go to the brain; its receipt (in the request language) is returned untouched,
  // never rewritten by a capability template in the UI locale.
  const owner={executeVoiceCapability:()=>{throw Error('no voice turn')}};
  const brain={success:true,state:'done',source:'samantha_brain',text:'batterie mte3ek 80%'};
  const tn=await clawLiveCapability(owner,{request:'9addech batterie'},async()=>({...brain}));
  assert.deepEqual(tn,brain);assert.ok(!Object.hasOwn(tn,'voice'),'French uiLocale speech must not override derja');
  console.log('request-language transport: PASS');
})().catch(error=>{console.error(error);process.exitCode=1});
