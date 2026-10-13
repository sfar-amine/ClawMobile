const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {publicDecision}=require('../dist/companion/receiptPresentation');
const {responseLanguageInstruction,submitToOpenClawAgent}=require('../dist/companion/openclawAgentClient');
const {VoiceUnderstandingState,clawLiveCapability}=require('../dist/companion/clawLiveUnderstanding');

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
  const owner={understanding:new VoiceUnderstandingState(()=>1000),sessionLocale:()=> 'en',executeVoiceCapability:(_m,_r,run)=>run()};
  const presentation={version:1,locale:'fr',status:'info',label:'Demande',title:'Résultat à vérifier',rows:[],spoken:'Réponse française.',primary:{label:'Terminer',action:'done'},effect:{debited:'unknown',source:'receipt'},meta:{capability:null},understood:{capability:null,label:'Demande',slots:{}},alternatives:[]};
  const tn=await clawLiveCapability(owner,{request:'9addech batterie'},async()=>({...base,decision:{...base,responseLanguage:'tn'},presentation}));
  assert.equal(tn.decision.responseLanguage,'tn');assert.ok(!Object.hasOwn(tn,'voice'),'French uiLocale speech must not override derja');
  const en=await clawLiveCapability(owner,{request:'my battery level'},async()=>({...base,decision:{...base,responseLanguage:'en'},presentation:{...presentation,locale:'en',spoken:'English answer.'}}));
  assert.equal(en.voice.locale,'en');assert.match(en.voice.verbatim,/^I understood:/);assert.ok(!en.voice.verbatim.includes('Compris'));
  console.log('request-language transport: 19/19');
})().catch(error=>{console.error(error);process.exitCode=1});
