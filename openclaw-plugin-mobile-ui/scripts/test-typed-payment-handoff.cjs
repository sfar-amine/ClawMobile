// S24 06/11: « paie ma facture SONEDE de 19,400 DT » ended with « route non active »: no typed tool carried a payment.
// The playbooks now project the inert payment hand-off (executionMode payment_handoff, risk transaction). The Companion
// accepts exactly that shape, never another transaction, and gives the hand-off the helper's 120 s budget.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../dist/capabilityAgentGuard.js');
const tools = require('../dist/typedCapabilityTools.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-payment-'));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/s24-2026-10-25-typed-tools/compiled-agent-tools.json'), 'utf8'));
const ctx = {senderIsOwner:true, agentId:'main', sessionKey:'agent:main:companion-chat-typed', sessionId:'session-1',
  assertInvocationCurrent() {}};
// Shape projected by samantha-ui-playbooks payment-brain-handoff-20261106 (skill_intelligence/typed_tools.py).
const pay = {action:'billing.pay', description:'payer ta facture SONEDE', risk:'transaction', confirmationRequired:false,
  directExecution:true, canonicalStatus:'ready', executionMode:'payment_handoff', ownerReferences:['web/sonede/playbook.md'],
  examples:['paie ma facture sonede'],
  params:{type:'object', properties:{reference:{type:'string', pattern:'^[A-Za-z0-9._-]{1,100}$', maxLength:100},
    amountTnd:{type:'string', pattern:'^[0-9]{1,6}([.,][0-9]{1,3})?$', maxLength:10}}, required:[], additionalProperties:false}};
function write(catalogue) {
  const views = path.join(root, '.openclaw/capability-views'); fs.mkdirSync(views, {recursive:true});
  fs.writeFileSync(path.join(views, 'agent-tools.json'), JSON.stringify(catalogue));
}
function withAction(action) {
  const value = JSON.parse(JSON.stringify(fixture));
  const sonede = value.tools.find(t => t.domain === 'sonede') || value.tools[0];
  sonede.actions.push(action);
  return {value, name: sonede.name, domain: sonede.domain};
}
function bind(name, args, callId) {
  return guard.agentCapabilityHook({toolName:name, params:args, toolCallId:callId},
    {requester:{senderIsOwner:true}, agentId:'main', runId:'user-run-pay', sessionKey:ctx.sessionKey, sessionId:ctx.sessionId});
}
async function main() {
  const base = tools.readTypedToolCatalogue.length; void base;
  // Any other transaction (or a payment hand-off that would ask a host recap) still rejects the whole view.
  for (const bad of [{...pay, executionMode:undefined}, {...pay, confirmationRequired:true}, {...pay, risk:'destructive'}]) {
    write(withAction(bad).value);
    assert.deepEqual(tools.readTypedToolCatalogue(root), [], JSON.stringify(bad));
  }
  const {value, name, domain} = withAction(pay);
  write(value);
  assert.equal(tools.readTypedToolCatalogue(root).length, value.tools.length);
  const helper = path.join(root, 'helper.py');
  fs.writeFileSync(helper, "import sys,json\np=json.load(sys.stdin)\nprint(json.dumps({'state':'COMPLETED','received':p,'argv':sys.argv[1:]}))\n");
  const descriptors = tools.createTypedCapabilityTools(ctx, {home:root, helperPath:helper});
  const tool = descriptors.find(t => t.name === name);
  assert.match(tool.description, /billing\.pay: payer ta facture SONEDE \(ouvre seulement la confirmation de paiement sur le téléphone, sur demande explicite d'Amine/);
  assert.doesNotMatch(tool.description, /billing\.pay: [^\n]*récapitulatif puis confirmation/);
  const args = {action:'billing.pay', params:{amountTnd:'19,400'}};
  assert.equal(bind(name, args, 'pay-1').block, undefined);
  const result = JSON.parse((await tool.execute('pay-1', args)).content[0].text);
  assert.equal(result.state, 'COMPLETED');
  assert.deepEqual(result.received.command, {operation:'call', domain, action:'billing.pay', params:{amountTnd:'19,400'}});
  assert.deepEqual(result.argv.slice(-2), ['--timeout', '120'], 'payment hand-off gets the helper ceiling');
  // A parameter the action does not declare never reaches a payment.
  const extra = {action:'billing.pay', params:{amountTnd:'19,400', card:'x'}};
  bind(name, extra, 'pay-2');
  const refused = await tool.execute('pay-2', extra);
  assert.equal(refused.isError, true);
  assert.equal(JSON.parse(refused.content[0].text).state, 'not_executed');
  // A read keeps the ordinary 30 s budget.
  const read = tool.parameters.properties.action.enum.find(a => a !== 'billing.pay' && !['confirm', 'cancel'].includes(a));
  bind(name, {action:read, params:{}}, 'read-1');
  const plain = JSON.parse((await tool.execute('read-1', {action:read, params:{}})).content[0].text);
  assert.deepEqual(plain.argv.slice(-2), ['--timeout', '30']);
  // Contacts never see the tools at all.
  assert.equal(tools.createTypedCapabilityTools({...ctx, senderIsOwner:false}, {home:root}), null);
  console.log('typed payment hand-off: ok');
}
main().catch(error => { console.error(error); process.exit(1); });
