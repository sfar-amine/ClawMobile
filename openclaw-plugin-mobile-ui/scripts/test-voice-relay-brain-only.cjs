const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// ADR 02/11 « le cerveau partout », step 3: the relay goes to the brain with no host switch.
delete process.env.SAMANTHA_BRAIN_ONLY;
process.env.CLAWMOBILE_AGENT_ID = 'contacts-pulse';
const sdk = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/s24-2026-10-25-gateway-observation/sdk-contract.json')));
assert(sdk.capture.runtimeCapture && sdk.capture.sanitized);
assert(sdk.parts.some(p => p.term === 'status: responseStatus' && p.excerpt.includes('runId: params.runId')));
const client = require('../dist/companion/openclawAgentClient');
const live = require('../dist/companion/clawLive');
const bridge = require('../dist/companion/capabilityBridge');
const model = require('../dist/modelFastPath');
let sideCalls = 0;
const forbidden = () => {sideCalls++; throw Error('pre-brain path forbidden');};
bridge.capabilityBridge = forbidden;
model.runModelFastPath = forbidden;
live.compactOwnerAgentContext = () => '';
const relay = require('../dist/companion/voiceRelay');
for (const seam of ['useDialogue', 'setVoiceRelayRoundCaptureForTest']) assert.equal(relay.voiceRelayTurnsForTest[seam] ?? relay[seam], undefined, seam);
const calls = [];
const terminal = (text = 'Réponse du cerveau.') => ({runId:'11111111-1111-4111-8111-111111111111',status:'ok',summary:'completed',result:{payloads:[{text}]}});
let answer = async () => terminal();
client.callOpenClawGateway = async (method, params, options) => {calls.push({method,params,options});return answer();};
(async () => {
  const text = 'Lis mes factures, mais ne paie rien. Puis explique les échéances sans perdre cette contrainte.';
  const first = await relay.voiceRelayTurnForTest('relay-1', text);
  assert.equal(first.state, 'done'); assert.equal(first.source, 'samantha_brain');
  assert.equal(first.text, 'Réponse du cerveau.'); assert(first.conversationId);
  let call = calls.at(-1);
  assert.equal(call.method, 'agent'); assert.equal(call.params.agentId, 'main');
  assert.match(call.params.sessionKey, /^agent:main:companion-chat-voice-brain-/);
  assert.equal(call.params.message, text); assert.equal(call.params.idempotencyKey, 'relay-1');
  assert(call.options.timeoutMs > 29000 && call.options.timeoutMs <= 30000); assert.equal(call.options.hardTimeoutMs,call.options.timeoutMs); assert.equal(call.options.expectFinal, true);
  assert.equal(call.params.deliver, false);
  assert(!('ownerAdmitted' in call.params)); assert(!('nativeOwnerAdmission' in call.params));
  const again = await relay.voiceRelayTurnForTest('relay-1', text);
  assert.equal(again.conversationId, first.conversationId);
  assert.equal(calls.at(-1).params.sessionKey, call.params.sessionKey);
  for (const reply of ['Oui, seulement les consulter.', 'Stop, laisse tomber', "non c'est pas ça", 'La première']) {
    const result = await relay.voiceRelayTurnForTest('follow-' + calls.length, '', first.conversationId, reply);
    assert.equal(result.state, 'done'); assert.equal(calls.at(-1).params.message, reply);
    assert.equal(calls.at(-1).params.sessionKey, call.params.sessionKey);
  }
  answer = async () => terminal('Quelle offre veux-tu consulter ?');
  const question = await relay.voiceRelayTurnForTest('main-question',text);
  assert.equal(question.state,'needs_clarification'); assert.equal(question.question,'Quelle offre veux-tu consulter ?');
  const questionSession=calls.at(-1).params.sessionKey;
  answer = async () => terminal('Voici les données vérifiées.');
  const continued = await relay.voiceRelayTurnForTest('main-answer','',question.conversationId,'20447');
  assert.equal(continued.state,'done'); assert.equal(calls.at(-1).params.sessionKey,questionSession);
  assert.equal(calls.at(-1).params.message,'20447');
  // Existing native tool authority is not reconstructed from the authenticated relay bearer/prompt.
  const {createTypedCapabilityTools} = require('../dist/typedCapabilityTools');
  const {agentCapabilityHook} = require('../dist/capabilityAgentGuard');
  assert.equal(createTypedCapabilityTools({agentId:'main',senderIsOwner:false,sessionKey:call.params.sessionKey}),null);
  assert.equal(agentCapabilityHook({toolName:'samantha_app',toolCallId:'relay-proof',params:{action:'interrupt',params:{owner:true}}},
    {agentId:'main',runId:'relay-run',sessionKey:call.params.sessionKey,requester:{senderIsOwner:false}}).block,true);
  answer = async () => {throw Object.assign(Error('missing scope: operator.admin'),{name:'GatewayClientRequestError',gatewayCode:'UNAVAILABLE',details:{code:'MISSING_SCOPE'}});};
  const denied = await relay.voiceRelayTurnForTest('denied', text);
  assert.equal(denied.error, 'missing_scope'); assert.equal(denied.success, false);
  assert.equal(denied.retrySafe, false); assert.equal(denied.text, undefined);
  answer = async () => ({runId:'real-run',status:'ok',summary:'completed',result:{payloads:[]}});
  const empty = await relay.voiceRelayTurnForTest('empty', text);
  assert.equal(empty.state, 'unknown'); assert.equal(empty.text, undefined);
  answer = async () => ({...terminal(),status:'timeout'});
  const uncertain = await relay.voiceRelayTurnForTest('timeout', text);
  assert.equal(uncertain.state, 'unknown'); assert.equal(uncertain.retrySafe, false);
  const oldNow = Object.getOwnPropertyDescriptor(performance, 'now'); let now = 0;
  Object.defineProperty(performance, 'now', {configurable:true,value:() => now});
  try {
    answer = async () => {now = 30001; return terminal('Réponse en retard.');};
    const before = calls.length;
    const late = await relay.voiceRelayTurnForTest('late', text);
    assert.equal(late.state, 'unknown'); assert.equal(late.error, 'voice_brain_budget_exhausted');
    assert.equal(late.text, undefined); assert.equal(calls.length, before + 1, 'no retry after uncertain effect');
  } finally {if(oldNow) Object.defineProperty(performance,'now',oldNow);else delete performance.now;}
  relay.stopVoiceRelay();
  const before = calls.length;
  const expired = await relay.voiceRelayTurnForTest('abandoned', '', first.conversationId, 'Oui');
  assert.equal(expired.error, 'conversation_expired'); assert.equal(calls.length,before);
  assert.equal(sideCalls, 0, 'no Dialogue/Graph/interpreter/realignment calls');
  // Execute the existing capsule handlers locally: HTTP502 keeps uncertainty truthful,
  // and a question from main enters its existing continuation instead of losing context.
  const vm=require('node:vm');
  for(const file of ['AskClaw.js','ContinueClaw.js']) {
    let payload={status:502,parsed:{success:false,state:'unknown',retrySafe:false}};
    const module={exports:null};
    const source=fs.readFileSync(path.join(__dirname,'../../integrations/bixby-claw/code',file),'utf8')
      .replace(/^import .*$/mg,'').replace('export default function','module.exports = function');
    vm.runInNewContext(source,{module,http:{postUrl:()=>payload},config:{get:()=> 'https://relay.example'},
      secret:{get:()=> 'local-test-token-more-than-24chars'},fail:{checkedError:(_msg,kind,data)=>Object.assign(Error(kind),{kind,data})},console:{error(){}}});
    const args=file==='AskClaw.js'?{request:text}:{conversationId:'brain-test',answer:'20447'};
    assert.equal(module.exports(args),'Le résultat de la demande reste à vérifier. Je ne la relance pas.');
    payload={status:502,parsed:{success:false,error:'missing_scope'}};
    assert.equal(module.exports(args),"L'accès autorisé à cette entrée vocale ne permet pas cette demande.");
    payload={status:200,parsed:{success:true,state:'needs_clarification',question:'Quelle offre ?',conversationId:'brain-test'}};
    assert.throws(()=>module.exports(args),e=>e.kind==='NeedsClarification'&&
      (file==='AskClaw.js'?e.data.conversationId==='brain-test':e.data.nextQuestion==='Quelle offre ?'));
  }
  console.log('voice-relay-brain-only: PASS (full message/main, continuity/idempotency, scoped denial, uncertain/late/abandoned, no pre-brain sidecalls; local SDK contract, not live P1)');
})().catch(e => {console.error(e);process.exitCode=1;});
