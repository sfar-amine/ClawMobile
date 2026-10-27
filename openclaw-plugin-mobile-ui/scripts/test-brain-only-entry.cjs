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
 const guard=require('../dist/capabilityAgentGuard');
 const {admitNativePulseContact}=require('../dist/nativePulseAdmission');
 const pulseSession='agent:contacts-pulse:whatsapp:direct:+21610000000';
 const pulseText='Lis offre 20447',pulseEventRef='l3-native-pulse-interpretation';
 let active=true;
 const admission=await admitNativePulseContact({sessionKey:pulseSession,eventRef:pulseEventRef,text:pulseText,isGroup:false},
  async()=>({success:true,contactId:'wa-b8ff0cd49ee9fe16',e164:'+21610000000',owner:false,state:active?'active':'removed',rooms:['pulse'],expiresAt:null}));
 const pulseEvent={surface:'pulse_room',conversationKey:admission.conversationKey,eventRef:pulseEventRef};
 await assert.rejects(guard.holdNativePulseInterpretation(JSON.parse(JSON.stringify(admission)),pulseEvent,pulseText),/admission_required/);
 const lease=await guard.holdNativePulseInterpretation(admission,pulseEvent,pulseText);
 // Authored public fixture; refs obtained independently from the canonical Python dialogue.model owner.
 const request={message:{ref:'evt-3c2c7fffa0841b08e6bbb99fdf5f76ae',text:pulseText,provenance:'server_verified'},catalogue:{domains:[{domain_id:'pulse'}]}};
 const nativeParams={systemPrompt:'Public Pulse contract fixture',message:'REQUEST='+JSON.stringify(request),model:port.INTERPRETER_PRIMARY,
  purpose:port.NATIVE_PULSE_PURPOSE,nativePulseInvocationId:lease.invocationId};
 const call=async params=>{const before=completions;let reply;await handler({params,respond:(...args)=>{reply=args}});return{reply,completions:completions-before};};
 for(const invalid of [
  {...nativeParams,nativePulseInvocationId:undefined},
  {...nativeParams,nativePulseInvocationId:'native-pulse-11111111-1111-4111-8111-111111111111'},
  {...nativeParams,model:port.INTERPRETER_FALLBACK},
  ...[
   {...request,message:{...request.message,text:'Un autre message'}},
   {...request,message:{...request.message,ref:'evt-foreign'}},
   {...request,message:{...request.message,provenance:'client_claimed'}},
   {...request,catalogue:{domains:[{domain_id:'pulse'},{domain_id:'owner_private'}]}},
  ].map(value=>({...nativeParams,message:'REQUEST='+JSON.stringify(value)})),
 ]){const denied=await call(invalid);assert.equal(denied.reply[0],false);assert.equal(denied.completions,0);}
 let native=await call(nativeParams);assert.equal(native.reply[0],true);assert.equal(native.completions,1,'live scoped Pulse admission survives main interpreter retirement');
 active=false;native=await call(nativeParams);assert.equal(native.reply[0],false);assert.equal(native.completions,0,'revocation reread before provider');
 active=true;lease.release();native=await call(nativeParams);assert.equal(native.reply[0],false);assert.equal(native.completions,0,'released lease cannot be replayed');
 console.log('brain-only-entry: PASS (voice/WA one decider, closed greeting reflex, no Graph/intent interpreter, immune owner preserved)');
})().catch(error=>{console.error(error);process.exitCode=1});
