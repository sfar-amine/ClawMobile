const assert=require('node:assert/strict');
process.env.SAMANTHA_BRAIN_ONLY='1';
const live=require('../dist/companion/clawLiveUnderstanding');
const brain=require('../dist/companion/voiceBrainDelegation');
const fast=require('../dist/modelFastPath');
const port=require('../dist/intentInterpreterPort');
(async()=>{
 const owner={understanding:new live.VoiceUnderstandingState(),sessionLocale:()=>'fr',executeVoiceCapability:(_m,_r,run)=>run()};
 let resolves=0,executions=0,submits=0;
 for(const text of ['Quel est mon solde Orange ?','Bonjour Samantha quel est mon solde ?','Oui','La première','Stop, laisse tomber']){
  const result=await live.clawLiveDecision(owner,text,async()=>{resolves++;throw Error('no resolver')});
  assert.deepEqual(result.voiceFastPath,{version:1,execute:true,owner:'samantha_brain'});
 }
 assert.equal(resolves,0);
 const reflex=await live.clawLiveDecision(owner,'Bonjour Samantha',async()=>{resolves++});
 assert.equal(reflex.voiceFastPath.execute,false);assert.equal(resolves,0);
 const ticket={},context={sessionId:'demo',clientRunId:'voice-cap-1',admission:ticket,assertCurrent(){}};
 const result=await brain.routeUnresolvedVoiceTurn('Quel est mon solde Orange ?',context,{
  resolve:async()=>{resolves++;throw Error('no resolver')},execute:async()=>{executions++;throw Error('no pre-brain effect')},
  submit:async()=>{submits++;return{success:true,accepted:true,runId:'run-1',state:'done',result:'Réponse vérifiée du cerveau.'}},
  status:async()=>{throw Error('no poll for terminal')},
 });
 assert.equal(result.state,'done');assert.equal(result.text,'Réponse vérifiée du cerveau.');assert.equal(submits,1);assert.equal(resolves,0);assert.equal(executions,0);
 const number='+21620000000',sessionKey='agent:main:whatsapp:direct:'+number;
 const wa=await fast.handleOwnerBeforeDispatch({channel:'whatsapp',content:'solde orange',sessionKey},{sessionKey},async()=>{resolves++;throw Error('no interpreter')},()=>new Set([number]));
 assert.equal(wa.handled,false);assert.equal(resolves,0);
 const replies=[];let completions=0;
 const handler=port.createInterpretHandler(()=>async()=>{completions++;return{text:'{"ok":true}'}});
 await handler({params:{systemPrompt:'x',message:'y'},respond:(...args)=>replies.push(args)});
 assert.equal(replies[0][0],false);assert.equal(completions,0);
 await handler({params:{systemPrompt:'x',message:'y',purpose:port.IMMUNE_PURPOSE,model:port.IMMUNE_MODELS[0]},respond:(...args)=>replies.push(args)});
 assert.equal(replies[1][0],true);assert.equal(completions,1,'C2 engineering completion owner survives interpreter retirement');
 console.log('brain-only-entry: PASS (voice/WA one decider, closed greeting reflex, no Graph/intent interpreter, immune owner preserved)');
})().catch(error=>{console.error(error);process.exitCode=1});
