// before_tool_call boundary: only the brain's typed samantha_* tools are admitted per invocation; the free-text
// clawmobile_capability tool is no longer registered (ADR 02/11 « le cerveau partout », step 3).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {agentCapabilityHook:hook,AGENT_CAPABILITY_REFUSAL}=require('../dist/capabilityAgentGuard.js');
const protocol=fs.readFileSync(path.join(__dirname,'../fixtures/protocol/openclaw-2026.9.6/e3-hook-excerpts.d.ts'),'utf8');
assert.match(protocol,/requester\?: PluginHookToolRequesterContext/);assert.match(protocol,/readonly senderIsOwner\?: boolean/);assert.match(protocol,/block\?: boolean/);assert.match(protocol,/params\?: Record<string, unknown>/);
let checks=4;
const blocked={block:true,blockReason:AGENT_CAPABILITY_REFUSAL};
assert.equal(AGENT_CAPABILITY_REFUSAL,'capability_first_required');checks++;
// The retired free-text tool gets no special admission (no caller rewriting): nothing registers it any more.
assert.equal(hook({toolName:'clawmobile_capability',params:{request:'recharge orange 5 dt',caller:'owner'}},{requester:{senderIsOwner:true}}),undefined);checks++;
// Typed tools: owner main turn with a current invocation only; arguments are frozen copies.
const ctx={requester:{senderIsOwner:true},runId:'run-1',sessionKey:'agent:main:companion-chat-x',agentId:'main'};
const live={action:'telecom.balance',params:{line:'orange'}};
const out=hook({toolName:'samantha_maxit_tunisie',toolCallId:'call-1',params:live},ctx);
live.params.line='changed';assert.equal(JSON.stringify(out.params),JSON.stringify({action:'telecom.balance',params:{line:'orange'}}));checks++;
for(const context of [{...ctx,requester:{senderIsOwner:false}},{...ctx,requester:{}},{...ctx,agentId:'contacts'},{...ctx,runId:undefined}])
  {assert.deepEqual(hook({toolName:'samantha_maxit_tunisie',toolCallId:'call-x',params:{}},context),blocked);checks++;}
assert.deepEqual(hook({toolName:'samantha_maxit_tunisie',toolCallId:'call-1',params:{}},ctx),blocked,'replayed call id');checks++;
const trapped=new Proxy({action:'x'},{getOwnPropertyDescriptor(){throw Error('inspection');}});
assert.deepEqual(hook({toolName:'samantha_app',toolCallId:'call-2',params:trapped},ctx),blocked);checks++;
// Other tools are untouched; a malformed event fails closed.
assert.equal(hook({toolName:'android_health',params:{}},{}),undefined);checks++;
assert.deepEqual(hook({toolName:42,params:{}},{}),blocked);checks++;

// Runtime registration: one before_tool_call, and no clawmobile_capability tool whatever the environment.
const hooks=[],tools=[];
require('../dist/index.js').register({on(name,fn){hooks.push([name,fn]);},registerTool(tool,opts){tools.push(opts);},logger:{}});
const before=hooks.filter(x=>x[0]==='before_tool_call');assert.equal(before.length,1);checks++;
assert(!tools.some(o=>o?.name==='clawmobile_capability'));checks++;
assert.equal(before[0][1]({toolName:'read',params:{path:'x'}},{}),undefined);checks++;
console.log(`agent tool guard: ${checks} checks passed`);
