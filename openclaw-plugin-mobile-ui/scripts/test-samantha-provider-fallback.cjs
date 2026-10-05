const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const mod=require('../dist/providerFallback.js');
const patch=JSON.parse(fs.readFileSync(path.join(__dirname,'../../docs/runtime/config/samantha-provider-fallback.json'),'utf8'));
const expected='google/gemini-3.5-flash-lite@google:claw-gemini-free';
assert.deepEqual(Object.keys(patch),['agents']);
assert.deepEqual(Object.keys(patch.agents.entries),['main']);
assert.equal(patch.agents.entries.main.model.primary,undefined,'Do not replace the owner-selected primary');
assert.deepEqual(patch.agents.entries.main.model.fallbacks,['openai/gpt-5.6-luna',expected]);
assert.deepEqual(patch.agents.entries.main.modelPolicy.allow,['openai/gpt-5.6-sol','openai/gpt-5.6-luna','google/gemini-3.5-flash-lite']);
const api={config:{channels:{whatsapp:{allowFrom:['+21611111111']}}},logger:{warn(){}}};
const base={agentId:'main',trigger:'user',channel:'whatsapp',sessionKey:'agent:main:whatsapp:direct:+21611111111'};
async function main(){
  let calls=0;
  const c=mod.createProviderFallbackCoordinator(api,async()=>{calls++;throw Error('must not retry Google')});
  const context={...base,runId:'native-google-already-tried'};
  c.beforeModelResolve({prompt:'harmless fixture'},context);
  c.modelCallEnded({provider:'openai',outcome:'error'},context);
  c.modelCallEnded({provider:'google',outcome:'error'},context);
  assert.equal(await c.beforeAgentReply({cleanedBody:'All models failed (3): openai/gpt-5.6-sol rate_limit | google/gemini-3.5-flash-lite quota'},context),undefined);
  assert.equal(calls,0);assert.equal(c._stateSize(),0);
  const withoutHook={...base,runId:'native-google-history'};
  c.beforeModelResolve({prompt:'harmless fixture'},withoutHook);
  c.modelCallEnded({provider:'openai',outcome:'error'},withoutHook);
  assert.equal(await c.beforeAgentReply({cleanedBody:'All models failed (3): openai/gpt-5.6-sol cooldown | google/gemini-3.5-flash-lite quota'},withoutHook),undefined);
  assert.equal(calls,0);
  for(const refusal of ['policy_refusal','safety_refusal','provider_policy_violation','content_policy_violation']){
    const ctx={...base,runId:refusal};
    c.beforeModelResolve({prompt:'harmless fixture'},ctx);
    c.modelCallEnded({provider:'openai',outcome:'error'},ctx);
    c.modelCallEnded({provider:'openai',outcome:refusal},ctx);
    assert.equal(await c.beforeAgentReply({cleanedBody:'Provider openai is in cooldown'},ctx),undefined);
    assert.equal(mod.isOpenAiTerminalError('All models failed: openai/gpt-5.6-sol '+refusal),false);
  }
  assert.equal(calls,0);assert.equal(c._stateSize(),0);
  console.log(JSON.stringify({ok:true,mainOnly:true,primaryPreserved:true,freeProfilePinned:true,nativeGoogleNotRetried:true,terminalRefusals:true}));
}
main().catch(error=>{console.error(error);process.exitCode=1});
