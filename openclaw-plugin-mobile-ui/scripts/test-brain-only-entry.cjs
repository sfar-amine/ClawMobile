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
 // A contact's Pulse room keeps its one admitted Gemini profile on the Pulse catalogue; no Gateway lease
 // (the room is admitted at its turn, Python re-reads the sealed contact evidence at send).
 const request={message:{ref:'evt-3c2c7fffa0841b08e6bbb99fdf5f76ae',text:'Lis offre 20447',provenance:'server_verified'},catalogue:{domains:[{domain_id:'pulse'}]}};
 const nativeParams={systemPrompt:'Public Pulse contract fixture',message:'REQUEST='+JSON.stringify(request),model:port.INTERPRETER_PRIMARY,
  purpose:port.NATIVE_PULSE_PURPOSE};
 const call=async params=>{const before=completions;let reply;await handler({params,respond:(...args)=>{reply=args}});return{reply,completions:completions-before};};
 for(const invalid of [
  {...nativeParams,model:port.INTERPRETER_FALLBACK},
  {...nativeParams,message:'Lis offre 20447'},
  {...nativeParams,message:'REQUEST='+JSON.stringify({...request,catalogue:{domains:[{domain_id:'pulse'},{domain_id:'owner_private'}]}})},
 ]){const denied=await call(invalid);assert.equal(denied.reply[0],false);assert.equal(denied.completions,0);}
 const native=await call(nativeParams);assert.equal(native.reply[0],true);assert.equal(native.completions,1,'scoped Pulse interpretation survives main interpreter retirement');
 console.log('brain-only-entry: PASS (voice/WA one decider, closed greeting reflex, no Graph/intent interpreter, immune owner preserved)');
})().catch(error=>{console.error(error);process.exitCode=1});
