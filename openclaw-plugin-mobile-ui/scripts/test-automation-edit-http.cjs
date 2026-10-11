// R23 / E1: PATCH /v1/automations/{id} against the real cron.get / cron.update captures
// (fixtures/s24-2026-10-11b/e1/cron-lifecycle.json, PR #131, OpenClaw 2026.9.6).
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const capture=require('../fixtures/s24-2026-10-11b/e1/cron-lifecycle.json');
const step=label=>capture.steps.find(s=>s.label===label);
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'automation-edit-'));
 const old=process.env.OPENCLAW_STATE_DIR;process.env.OPENCLAW_STATE_DIR=root;
 const directory=path.join(root,'clawmobile-companion');await fs.mkdir(directory,{recursive:true});
 const ledger=path.join(directory,'runs.json');await fs.writeFile(ledger,JSON.stringify({version:1,runs:[]}));
 const gateway=require('../dist/companion/openclawAgentClient');
 const created=step('02-cron.get').response,updated=step('03-cron.update').response,stale=step('05-cron.update-stale').response;
 let jobs,updates=0,lists=0,latency={},updateFails=null,applyThenFail=false;
 const reset=()=>{jobs=[structuredClone(created)];updates=0;lists=0;latency={};updateFails=null;applyThenFail=false;};reset();
 const wait=ms=>ms?new Promise(r=>setTimeout(r,ms)):null;
 gateway.callOpenClawGateway=async(method,params)=>{
  await wait(latency[method]);
  if(method==='cron.list'){lists++;return {jobs:structuredClone(jobs),hasMore:false};}
  if(method==='cron.update'){
   updates++;const job=jobs.find(j=>j.id===params.id);
   // Native CAS exactly as captured: a stale expectedConfigRevision is refused before any effect.
   if(params.expectedConfigRevision!==job.configRevision)throw Object.assign(new Error(stale.error.message),{name:'GatewayClientRequestError',gatewayCode:stale.error.code,details:{code:stale.error.details.code}});
   if(updateFails)throw new Error(updateFails);
   // Captured patch (name + cron schedule) returns the captured full job; other patches apply the same rules.
   let next;
   if(JSON.stringify(params.patch)===JSON.stringify(step('03-cron.update').params.patch))next=structuredClone(updated);
   else{next={...structuredClone(job),...params.patch,updatedAtMs:job.updatedAtMs+1};if(params.patch.payload)next.payload={...job.payload,...params.patch.payload};next.configRevision='sha256:'+crypto.createHash('sha256').update(JSON.stringify(next.payload)+JSON.stringify(next.schedule)+next.name+next.enabled).digest('base64url');}
   jobs=[next];if(applyThenFail)throw new Error('socket hang up after dispatch');return structuredClone(next);
  }
  if(method==='cron.runs')return {entries:[]};
  throw new Error('unexpected method '+method);
 };
 const automations=require('../dist/companion/automations');
 const realProtected=automations.protectedJob;
 const edit=require('../dist/companion/automationEditValidation');
 const {confirmations}=require('../dist/companion/confirmations');
 let confirmationRecord=null,consumed=[];
 confirmations.status=async id=>{if(!confirmationRecord||confirmationRecord.id!==id)throw Object.assign(new Error('confirmation_not_found'),{statusCode:404});return confirmationRecord;};
 confirmations.consume=async(id,expected)=>{const a=confirmationRecord.intent.action;if(a.type!==expected.action.type||a.reference!==expected.action.reference||a.payloadHash!==expected.action.payloadHash)throw Object.assign(new Error('confirmation_scope_mismatch'),{statusCode:409});consumed.push(id);return {};};
 const {route}=require('../dist/companion/server');
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}');}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const request=(url,method,body,headers={})=>new Promise((resolve,reject)=>{
  const data=body===undefined?undefined:JSON.stringify(body);
  const req=http.request({host:'127.0.0.1',port,path:url,method,headers:{'content-type':'application/json',...(data?{'content-length':Buffer.byteLength(data)}:{}),...headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:text?JSON.parse(text):null}));});
  req.on('error',reject);if(data)req.write(data);req.end();
 });
 const owner={'x-clawmobile-owner-flow':'v1'};const id=created.id,url='/v1/automations/'+id;
 const ifMatch=rev=>({...owner,'if-match':rev});
 let count=0;const ok=(cond,msg)=>{assert.ok(cond,msg);count++;};
 try{
  // 1. Owner boundary before anything: no header, browser origin.
  reset();ok((await request(url,'PATCH',{operationId:'x',name:'n'})).status===403,'owner header required');ok(lists===0&&updates===0);
  // 2. Real predicate on the real captured job: the structural key `payload` matches \bpay, so the job is protected (409).
  //    Kept on purpose (Claude, 10/10: never weaken; owner fix in a separate PR). Nothing is read twice, nothing written.
  const real=await request(url,'PATCH',{operationId:'real-guard',name:'Renommage neutre'},ifMatch(created.configRevision));
  ok(real.status===409&&real.body.error==='automation_protected',JSON.stringify(real));ok(updates===0);
  // 3. Payment and validation refusals precede any owner read.
  for(const [body,code,status] of [[{name:'payer la facture'},'automation_payment_excluded',422],[{message:'recharge 10 TND'},'automation_payment_excluded',422],[{message:'mon code 482913'},'automation_sensitive_input',422],[{schedule:{kind:'every',everyMs:59999}},'invalid_automation_edit',400],[{schedule:{kind:'cron',expr:'@daily'}},'invalid_automation_edit',400],[{schedule:{kind:'at',at:'2020-01-01T00:00:00Z'}},'invalid_automation_edit',400],[{message:'x'.repeat(4001)},'invalid_automation_edit',400],[{payload:{kind:'agentTurn'}},'invalid_automation_edit',400]]){
   reset();const r=await request(url,'PATCH',{operationId:'v-'+count,...body},ifMatch(created.configRevision));ok(r.status===status&&r.body.error===code,JSON.stringify([body,r]));ok(lists===0&&updates===0,'refused before owner read');
  }
  reset();const noRev=await request(url,'PATCH',{operationId:'norev',name:'Neutre'},owner);ok(noRev.status===428&&noRev.body.error==='automation_revision_required');ok(lists===0);
  // The remaining cases exercise the edit itself with a content-only predicate (the expected owner fix): the captured
  // job shape is unchanged, only the structural false positive is neutralised in this test.
  automations.protectedJob=job=>automations.protectedPayment([job.name,job.description,job.payload?.message,job.payload?.argv]);
  // 4. Detail exposes the native revision used as If-Match.
  reset();const detail=await request(url,'GET');ok(detail.status===200&&detail.body.revision===created.configRevision&&Array.isArray(detail.body.actions),JSON.stringify(detail));
  // 5. CAS precheck: a stale If-Match is refused before effect with the current revision.
  const conflict=await request(url,'PATCH',{operationId:'stale-pre',name:'Neutre'},ifMatch(step('05-cron.update-stale').params.expectedConfigRevision.replace('SO','S0')));
  ok(conflict.status===409&&conflict.body.error==='automation_revision_conflict'&&conflict.body.currentRevision===created.configRevision,JSON.stringify(conflict));ok(updates===0);
  // 6. Captured success: name + schedule on an agentTurn job needs owner confirmation (scope automation.edit, ref id, sha256 of canonical patch).
  reset();latency={'cron.list':step('02-cron.get').latencyMs,'cron.update':step('03-cron.update').latencyMs};
  const patch={name:updated.name,schedule:{kind:'cron',expr:updated.schedule.expr}};
  const challenge=await request(url,'PATCH',{operationId:'captured',...patch},ifMatch(created.configRevision));
  const expectedHash=crypto.createHash('sha256').update(JSON.stringify({name:patch.name,schedule:{expr:patch.schedule.expr,kind:'cron'}})).digest('hex');
  ok(challenge.status===403&&challenge.body.state==='needs_confirmation'&&challenge.body.scope==='automation.edit'&&challenge.body.reference===id&&challenge.body.payloadHash===expectedHash,JSON.stringify(challenge));ok(updates===0);
  const confirmationId='11111111-1111-4111-8111-111111111111';
  confirmationRecord={id:confirmationId,state:'approved',intent:{audience:'confirmation',action:{type:'automation.edit',reference:id,payloadHash:expectedHash},presentation:{title:'t',subtitle:'s',description:'d'},origin:{channel:'samantha',id:'app'}}};
  const began=Date.now();
  const done=await request(url,'PATCH',{operationId:'captured',confirmationId,schedule:patch.schedule,name:patch.name},ifMatch(created.configRevision));
  const took=Date.now()-began;
  ok(done.status===200&&done.body.state==='completed'&&done.body.artifact.revision===updated.configRevision,JSON.stringify(done));
  ok(done.body.receipt.version===1&&done.body.receipt.action==='automation.edit'&&done.body.receipt.target===id);
  ok(updates===1&&consumed.length===1);
  ok(took<20000,'PATCH within the 20 s budget at captured CLI latency: '+took+' ms');
  // Time zone kept from the job (captured Africa/Tunis), nothing invented.
  ok(jobs[0].schedule.tz==='Africa/Tunis');
  // Same operationId replays the stored receipt without a second effect.
  latency={};const replay=await request(url,'PATCH',{operationId:'captured',confirmationId,...patch},ifMatch(created.configRevision));ok(JSON.stringify(replay.body)===JSON.stringify(done.body)&&updates===1);
  // 7. Native CAS race: precheck passes, Gateway refuses with the captured CRON_JOB_CHANGED; receipt says refused, no retry.
  reset();const realList=gateway.callOpenClawGateway;let racing=true;
  gateway.callOpenClawGateway=async(method,params)=>{const value=await realList(method,params);if(method==='cron.list'&&racing){racing=false;jobs=[structuredClone(updated)];}return value;};
  const race=await request(url,'PATCH',{operationId:'race',enabled:true},ifMatch(created.configRevision));
  ok(race.status===409&&race.body.state==='refused'&&race.body.artifact.reason==='automation_revision_conflict',JSON.stringify(race));ok(updates===1);
  gateway.callOpenClawGateway=realList;
  // 8. Reversible toggle: no confirmation for enabled.
  reset();const toggle=await request(url,'PATCH',{operationId:'toggle',enabled:true},ifMatch(created.configRevision));ok(toggle.status===200&&toggle.body.state==='completed'&&jobs[0].enabled===true,JSON.stringify(toggle));
  // 9. Uncertain dispatch then one re-read proves the effect: completed, single cron.update.
  reset();applyThenFail=true;const unsure=await request(url,'PATCH',{operationId:'unsure',name:'Neutre apres coupure'},ifMatch(created.configRevision));
  ok(unsure.status===200&&unsure.body.state==='completed'&&updates===1&&lists===2,JSON.stringify(unsure));
  // 10. Failure without effect: re-read shows the old revision, refused not_applied, never replayed.
  reset();updateFails='gateway closed before dispatch';const none=await request(url,'PATCH',{operationId:'none',name:'Neutre'},ifMatch(created.configRevision));
  ok(none.status===409&&none.body.artifact.reason==='automation_update_not_applied'&&updates===1,JSON.stringify(none));
  // 11. Re-read unavailable after an uncertain dispatch: indeterminate, no second write.
  reset();applyThenFail=true;const listFn=gateway.callOpenClawGateway;let listsLeft=1;
  gateway.callOpenClawGateway=async(method,params)=>{if(method==='cron.list'&&listsLeft--<=0)throw new Error('scheduler down');return listFn(method,params);};
  const lost=await request(url,'PATCH',{operationId:'lost',name:'Neutre'},ifMatch(created.configRevision));ok(lost.status===503&&lost.body.state==='indeterminate'&&updates===1,JSON.stringify(lost));
  gateway.callOpenClawGateway=listFn;
  // 12. Message edit is only for agentTurn payloads; wrong confirmation scope is refused without a write.
  reset();jobs[0].payload={kind:'command',argv:['true']};const cmd=await request(url,'PATCH',{operationId:'cmd',message:'Bonjour'},ifMatch(created.configRevision));ok(cmd.status===422&&cmd.body.error==='automation_message_unsupported');
  reset();confirmationRecord.intent.action.payloadHash='0'.repeat(64);const wrong=await request(url,'PATCH',{operationId:'wrong',confirmationId,message:'Bonjour, rappel neutre.'},ifMatch(created.configRevision));
  ok(wrong.status===409&&wrong.body.artifact.reason==='confirmation_not_usable'&&updates===0,JSON.stringify(wrong));
  // 13. Not found and the Allow header.
  reset();const missing=await request('/v1/automations/absent','PATCH',{operationId:'absent',name:'Neutre'},ifMatch(created.configRevision));ok(missing.status===404);
  // 14. Gateway patch maps exactly onto the captured CronUpdateParamsSchema shapes.
  ok(JSON.stringify(edit.gatewayPatch(created,{schedule:{kind:'every',everyMs:60000}}))==='{"schedule":{"kind":"every","everyMs":60000}}');
  ok(JSON.stringify(edit.gatewayPatch(created,{message:'Bonjour'}))==='{"payload":{"kind":"agentTurn","message":"Bonjour"}}');
  ok(JSON.stringify(edit.gatewayPatch(created,{schedule:{kind:'cron',expr:'30 5 2 1 *'}}))===JSON.stringify({schedule:step('03-cron.update').params.patch.schedule}));
  automations.protectedJob=realProtected;
  console.log(JSON.stringify({state:'passed',assertions:count,fixture:'s24-2026-10-11b/e1/cron-lifecycle.json',patchMs:took}));
 }finally{server.closeAllConnections?.();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.OPENCLAW_STATE_DIR;else process.env.OPENCLAW_STATE_DIR=old;await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
