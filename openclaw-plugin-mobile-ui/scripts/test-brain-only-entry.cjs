const assert=require('node:assert/strict');
// ADR 02/11 « le cerveau partout », step 3: brain-only is unconditional; it must hold with no environment switch.
// A leftover value in the host environment changes nothing (the S24 still carries SAMANTHA_BRAIN_ONLY=1).
process.env.SAMANTHA_BRAIN_ONLY='0';
const fs=require('node:fs'),path=require('node:path');
const live=require('../dist/companion/clawLiveUnderstanding');
const brain=require('../dist/companion/voiceBrainDelegation');
const fast=require('../dist/modelFastPath');
const port=require('../dist/intentInterpreterPort');
(async()=>{
 let submits=0;
 for(const text of ['Quel est mon solde Orange ?','Bonjour Samantha quel est mon solde ?','Oui','La première','Stop, laisse tomber']){
  const result=live.clawLiveDecision(text);
  assert.deepEqual(result.voiceFastPath,{version:1,execute:true,owner:'samantha_brain'});
  assert.equal(result.harness.tool_policy,'required');
 }
 // Kept by Amine's decision (25/10): the closed social reflexes stay with the voice interface.
 const reflex=live.clawLiveDecision('Bonjour Samantha');
 assert.equal(reflex.voiceFastPath.execute,false);
 const ticket={},context={sessionId:'demo',clientRunId:'voice-cap-1',admission:ticket,assertCurrent(){}};
 const result=await brain.routeVoiceTurnToBrain('Quel est mon solde Orange ?',context,{
  submit:async()=>{submits++;return{success:true,accepted:true,runId:'run-1',state:'done',result:'Réponse vérifiée du cerveau.'}},
  status:async()=>{throw Error('no poll for terminal')},
 });
 assert.equal(result.state,'done');assert.equal(result.text,'Réponse vérifiée du cerveau.');assert.equal(submits,1);assert.equal(result.timing.route,'brain');assert.equal(result.timing.resolveMs,0);
 let capability=0;
 const executed=await live.clawLiveCapability({executeVoiceCapability:()=>{throw Error('no voice turn')}},{request:'Quel est mon solde Orange ?'},async text=>{capability++;return{state:'done',source:'samantha_brain',text}});
 assert.equal(executed.text,'Quel est mon solde Orange ?');assert.equal(capability,1);
 // Owner WhatsApp: no coordinator hook before the agent any more, and no free-text capability tool.
 for(const name of ['handleOwnerBeforeDispatch','handleOwnerFastPath','isOwnerFastPathEligible'])assert.equal(fast[name],undefined,name);
 const hooks=[],tools=[];
 require('../dist/index.js').register({on:(name,fn)=>hooks.push([name,fn]),logger:{},registerTool:(tool,opts)=>tools.push(opts),registerGatewayMethod(){},runtime:{}});
 assert(!hooks.some(([name])=>name==='inbound_claim'),'no owner inbound_claim coordinator');
 assert(!tools.some(opts=>opts?.name==='clawmobile_capability'||opts?.names?.includes?.('clawmobile_capability')),'free-text capability tool retired');
 assert(tools.some(opts=>Array.isArray(opts?.names)&&opts.names.includes('samantha_catalogue')),'typed tools registered without any switch');
 const number='+21620000000',sessionKey='agent:main:whatsapp:direct:'+number;
 const before=hooks.filter(([name])=>name==='before_dispatch');
 for(const [,fn] of before)assert.equal(await fn({channel:'whatsapp',content:'solde orange',sessionKey},{sessionKey}),undefined,'owner WhatsApp turn reaches the brain');
 const src=fs.readdirSync(path.join(__dirname,'../src'),{recursive:true}).filter(f=>/\.ts$/.test(f));
 for(const f of src)assert(!fs.readFileSync(path.join(__dirname,'../src',f),'utf8').includes('SAMANTHA_BRAIN_ONLY'),f+' reads the retired switch');
 assert(!fs.readFileSync(path.join(__dirname,'../../installer/termux-lite/model-fast-path.py'),'utf8').includes('SAMANTHA_BRAIN_ONLY'),'model-fast-path.py reads the retired switch');
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
  {...nativeParams,model:'openai/gpt-5.6-terra'},
  {...nativeParams,message:'Lis offre 20447'},
  {...nativeParams,message:'REQUEST='+JSON.stringify({...request,catalogue:{domains:[{domain_id:'pulse'},{domain_id:'owner_private'}]}})},
 ]){const denied=await call(invalid);assert.equal(denied.reply[0],false);assert.equal(denied.completions,0);}
 const native=await call(nativeParams);assert.equal(native.reply[0],true);assert.equal(native.completions,1,'scoped Pulse interpretation survives main interpreter retirement');
 console.log('brain-only-entry: PASS (voice/WA one decider, closed greeting reflex, no Graph/intent interpreter, immune owner preserved)');
})().catch(error=>{console.error(error);process.exitCode=1});
