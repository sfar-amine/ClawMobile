const test=require('node:test');
const assert=require('node:assert/strict');
const {executeRawCommand}=require('../dist/companion/mcpBridge.js');
const args={command:'printf OK',action_key:'same-task',step_key:'diagnostic',timeout_ms:5000};
const request='mcp-codex-cloud-same-task-diagnostic';
const observed=require('../fixtures/s24-2026-10-15/mcp-continuum-learning-capture.json');
assert.equal(observed.raw_diagnostic.error,'continuum_fence_required');
assert.equal(observed.capture_status.state,'completed');
assert.equal(observed.capture_status.continuum.state,'verification_required');
function fixture({status={...observed.capture_status.continuum,capability:observed.capture_status.capability},prepare={state:'ready',dispatch_allowed:true,wire_step_id:'continuum-wire',continuum_fence:{version:1,attemptId:'canonical-a',effectKey:'canonical-effect',ownershipEpoch:2,ownerId:'mcp-codex-cloud',bootId:'canonical-boot'}},existing=null}={}){
 const calls=[];
 return {calls,hasTask:()=>true,ingress:async argv=>{calls.push(argv);if(argv[0]==='status')return status;if(argv[0]==='prepare')return prepare;return {state:'verification_required'};},getRequest:()=>existing,submit:async value=>{calls.push(value);return {requestId:request,taskId:'mcp:codex-cloud:same-task',stepId:value.stepId,method:'exec_wait',state:'completed',result:{success:true,stdout:'OK'}};}};
}
test('raw owner execution on durable task prepares one canonically bound write fence',async()=>{
 const f=fixture();const out=await executeRawCommand(request,'codex-cloud','chat-owner',args,f);
 assert.equal(out.state,'completed');assert.equal(out.result.stdout,'OK');
 const prepare=f.calls.find(x=>Array.isArray(x)&&x[0]==='prepare');
 assert.equal(prepare[prepare.indexOf('--capability')+1],'engineering.learning_gate');
 assert.equal(prepare[prepare.indexOf('--risk')+1],'write');
 assert.equal(prepare[prepare.indexOf('--request-id')+1],request);
 const sent=f.calls.find(x=>!Array.isArray(x));assert.equal(sent.stepId,'continuum-wire');assert.equal(sent.continuumFence.attemptId,'canonical-a');assert.equal(sent._claw_access.owner,true);
 assert.equal(f.calls.filter(x=>!Array.isArray(x)).length,1);
});
test('shadow admission and malformed action are rejected before ingress or effects',async()=>{
 const f=fixture();await assert.rejects(executeRawCommand(request,'codex-cloud','chat-owner-shadow',args,f),/owner_profile_required/);
 await assert.rejects(executeRawCommand('wrong-id','codex-cloud','chat-owner',args,f),/action_request_id_mismatch/);assert.equal(f.calls.length,0);
});
test('unresolved attempt remains observation-only and cannot submit a shell command',async()=>{
 const f=fixture({prepare:{state:'busy',mission_state:'verification_required',dispatch_allowed:false}});
 const out=await executeRawCommand(request,'codex-cloud','chat-owner',args,f);assert.equal(out.state,'verification_required');assert.equal(out.retry_allowed,false);assert.equal(f.calls.some(x=>!Array.isArray(x)),false);
});
test('unknown canonical capability and absent canonical fence fail closed',async()=>{
 const missing=fixture({status:{state:'waiting'}});const out=await executeRawCommand(request,'codex-cloud','chat-owner',args,missing);assert.equal(out.error,'continuum_capability_unavailable');assert.equal(missing.calls.some(x=>!Array.isArray(x)),false);
 const nofence=fixture({prepare:{state:'ready',dispatch_allowed:true,wire_step_id:'wire'}});await assert.rejects(executeRawCommand(request,'codex-cloud','chat-owner',args,nofence),/continuum_fence_required/);assert.equal(nofence.calls.some(x=>!Array.isArray(x)),false);
});
test('failed status read never falls back to an unfenced execution',async()=>{
 let effects=0;await assert.rejects(executeRawCommand(request,'codex-cloud','chat-owner',args,{hasTask:()=>true,ingress:async()=>{throw Error('status unavailable');},submit:async()=>{effects++;}}),/status unavailable/);assert.equal(effects,0);
});
test('a standalone raw command preserves the existing receipt path without creating a task',async()=>{
 const f=fixture({status:{state:'not_found'}});const out=await executeRawCommand(request,'codex-cloud','chat-owner',args,f);assert.equal(out.state,'completed');assert.equal(f.calls.some(x=>Array.isArray(x)&&x[0]==='prepare'),false);assert.equal(f.calls.find(x=>!Array.isArray(x)).continuumFence,undefined);
});
test('same request replay observes its stored receipt and changed arguments are rejected',async()=>{
 const hash=require('node:crypto').createHash('sha256').update(JSON.stringify({method:'exec_wait',params:{command:'printf OK',timeoutMs:5000}})).digest('hex');
 const existing={requestId:request,taskId:'mcp:codex-cloud:same-task',stepId:'continuum-wire',method:'exec_wait',paramsHash:hash,state:'completed',result:{stdout:'FIRST'}};
 const f=fixture({existing});const out=await executeRawCommand(request,'codex-cloud','chat-owner',args,f);assert.equal(out.result.stdout,'FIRST');assert.equal(f.calls.some(x=>!Array.isArray(x)||x[0]==='prepare'),false);
 await assert.rejects(executeRawCommand(request,'codex-cloud','chat-owner',{...args,command:'printf CHANGED'},f),/request_id_conflict/);
});

test('malformed canonical status cannot dispatch an unfenced command',async()=>{
 const f=fixture({status:{}});await assert.rejects(executeRawCommand(request,'codex-cloud','chat-owner',args,f),/continuum_status_invalid/);assert.equal(f.calls.some(x=>!Array.isArray(x)),false);
});

test('canonical Bridge absence preserves standalone commands without Python or playbooks dependency',async()=>{
 const f=fixture();f.hasTask=()=>false;f.ingress=async()=>{throw Error('must not invoke Python without task');};
 const out=await executeRawCommand(request,'codex-cloud','chat-owner',args,f);assert.equal(out.state,'completed');assert.equal(f.calls.filter(x=>!Array.isArray(x)).length,1);
});
test('canonical task reader failure is not interpreted as absence',async()=>{
 const f=fixture();f.hasTask=()=>{throw Error('continuum_journal_invalid');};
 await assert.rejects(executeRawCommand(request,'codex-cloud','chat-owner',args,f),/continuum_journal_invalid/);assert.equal(f.calls.length,0);
});
test('task appearing after absence is rejected by the Bridge without fallback or replay',async()=>{
 const f=fixture();f.hasTask=()=>false;let submissions=0;f.submit=async()=>{submissions++;throw Error('continuum_fence_required');};
 await assert.rejects(executeRawCommand(request,'codex-cloud','chat-owner',args,f),/continuum_fence_required/);assert.equal(submissions,1);assert.equal(f.calls.length,0);
});
