import fs from 'fs/promises';
import {constants} from 'fs';
import path from 'path';
import os from 'os';
import {createHash} from 'crypto';
import {callOpenClawGateway,expectedCompanionSessionKey} from './openclawAgentClient';
import {confirmations} from './confirmations';
import {ownerUuid,type OwnerIntent} from './ownerConfirmationProtocol';
import {ownerBinding} from './ownerConfirmationProtocol';
import {findSubmittedRunByClientRunId,reserveSubmittedRun,settleSubmittedRun,claimFailedApprovalOperation} from './runs';

const failure=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
const identifier=/^[A-Za-z0-9_.:-]{1,100}$/;
const operationIdentifier=/^[A-Za-z0-9_.:-]{1,128}$/;
const financial=/(?:payment[._]|banqu|bank|carte|card|otp|3[- ]?d[ -]?secure|virement|transfer|transaction|achat|checkout|facture|wallet|topnet|maxit|flouci|\bd17\b|clictopay|termux-notification|\b\d+(?:[.,]\d+)?\s*(?:tnd|eur|usd|dt|€|\$))/i;
const secret=/(?:bearer\s|authorization|api[_-]?key|token[=: ]|password|secret[=: ]|-----BEGIN|\+?\d{8,})/i;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
type Kind='exec'|'plugin';
type Pending={id:string;kind:Kind;expiresAt:number;sessionKey?:string;runId?:string;toolCallId?:string;allowed:string[];reason:string|null;decided?:string};
type Linked=Pending&{runId:string|null};
type Snapshot={items:Linked[];at:number;issues:string[]};
let snapshot:Snapshot={items:[],at:0,issues:['approval_snapshot_not_ready']};
let refreshing:Promise<void>|null=null;
const CACHE_MS=15000;
const RPC_MS=12000;
const rpc=(method:string,params:Record<string,unknown>={})=>callOpenClawGateway(method,params,{timeoutMs:RPC_MS,hardTimeoutMs:RPC_MS});
/** Only syntactically inert probes constitute readable non-financial exec proof here. */
function inertCommand(request:any){
 const argv=request.commandArgv;
 if(argv!==undefined&&(!Array.isArray(argv)||argv.length>20||argv.some((x:any)=>typeof x!=='string')))return false;
 const command=request.command??request.commandText??(argv?argv.join(' '):'');
 if(typeof command!=='string'||command.length>2000||/[\n\r\x00$`\\;|&<>()[\]{}]/.test(command))return false;
 if(argv&&argv.join(' ')!==command)return false;
 return /^(?:date|uname(?: -[amrsv])?|id(?: -[ugn])?|whoami|pwd)$/.test(command)||/^(?:echo|printf) [A-Za-z0-9 _.,:%/+=-]{1,512}$/.test(command);
}
function closed(value:any,keys:string[]){return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));}
const requestKeys=['command','commandText','commandPreview','commandArgv','env','cwd','nodeId','host','security','ask','agentId','resolvedPath','sessionKey','sessionId','runId','toolCallId','allowedDecisions','warningText','scope','systemRunPlan','pluginId','title','description','severity','toolName','tool','summary','risk','reason','turnSourceChannel','turnSourceTo','turnSourceAccountId','toolArgs','requestText'];
const rowKeys=['id','approvalKind','kind','request','createdAtMs','expiresAtMs','expiresAt','allowedDecisions','decision','resolvedAtMs','status',...requestKeys];
/** Closed compatibility decoder. Unknown fields are not interpreted as permission. */
export function decodePendingApprovals(value:any,kind:Kind):Pending[]{
 let rows:any[];
 if(Array.isArray(value))rows=value;
 else if(closed(value,['approvals'])&&Array.isArray(value.approvals))rows=value.approvals;
 else if(closed(value,['requests'])&&Array.isArray(value.requests))rows=value.requests;
 else throw failure('approval_schema_unqualified',503);
 if(rows.length>100)throw failure('approval_schema_unqualified',503);
 const seen=new Set<string>();
 return rows.map(row=>{
  if(!closed(row,rowKeys)||!identifier.test(row.id||'')||seen.has(row.id)||row.approvalKind&&row.approvalKind!==kind||row.kind&&row.kind!==kind)throw failure('approval_schema_unqualified',503);
  seen.add(row.id);
  const request=row.request===undefined?row:row.request;
  if(row.request!==undefined&&!closed(request,requestKeys))throw failure('approval_schema_unqualified',503);
  const expiresAt=row.expiresAtMs??row.expiresAt;
  if(typeof expiresAt!=='number'||!Number.isSafeInteger(expiresAt)||expiresAt<=0)throw failure('approval_schema_unqualified',503);
  for(const key of ['sessionKey','runId','toolCallId'])if(request[key]!=null&&(typeof request[key]!=='string'||request[key].length>200))throw failure('approval_schema_unqualified',503);
  const allowed=request.allowedDecisions??row.allowedDecisions;
  if(allowed!==undefined&&(!Array.isArray(allowed)||allowed.some((x:any)=>!['allow-once','allow-always','deny'].includes(x))))throw failure('approval_schema_unqualified',503);
  if(kind==='plugin'&&allowed===undefined)throw failure('approval_schema_unqualified',503);
  if(row.decision!=null&&!['allow-once','allow-always','deny'].includes(row.decision)||row.status!=null&&!['pending','allowed','denied','expired','cancelled'].includes(row.status))throw failure('approval_schema_unqualified',503);
  if(JSON.stringify(request).length>65536)throw failure('approval_schema_unqualified',503);
  const text=JSON.stringify(Object.fromEntries(Object.entries(request).filter(([key])=>requestKeys.includes(key)&&!['agentId','nodeId','host','sessionKey','sessionId','runId','toolCallId','allowedDecisions','turnSourceChannel','turnSourceAccountId'].includes(key))));
  // Missing readable action proof and sensitive metadata never authorize an effect.
  const readable=kind==='exec'?[request.command,request.commandText,request.commandArgv].some(x=>typeof x==='string'&&x.length>0||Array.isArray(x)&&x.length>0):typeof(request.toolName??request.tool)==='string';
  const reason=financial.test(text)?'approval_payment_excluded':secret.test(text)?'approval_sensitive_details':!readable?'approval_details_unqualified':row.status==='expired'?'approval_expired':row.decision||row.resolvedAtMs||row.status&&row.status!=='pending'?'approval_already_decided':kind==='exec'&&!inertCommand(request)?'approval_payment_scope_unqualified':kind==='plugin'?'approval_plugin_payment_scope_unqualified':null;
  return {id:row.id,kind,expiresAt,sessionKey:request.sessionKey||undefined,runId:request.runId||undefined,toolCallId:request.toolCallId||undefined,allowed:allowed||['allow-once','deny'],reason,decided:row.decision||undefined};
 });
}
async function registry(){
 const directory=path.join(process.env.OPENCLAW_STATE_DIR||path.join(os.homedir(),'.openclaw'),'clawmobile-companion');
 const dir=await fs.lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw failure('approval_owner_unavailable',503);
 const file=await fs.open(path.join(directory,'runs.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const stat=await file.stat();if(!stat.isFile()||stat.size>8*1024*1024)throw Error();const raw=JSON.parse(await file.readFile('utf8'));
  if(!Array.isArray(raw.runs)||!Array.isArray(raw.paymentRequests)||!Array.isArray(raw.ownerConfirmations))throw Error();return raw;
 }catch{throw failure('approval_owner_unavailable',503);}finally{await file.close();}
}
function paymentRun(run:any,store:any){
 if(financial.test(JSON.stringify({text:run.text,userText:run.userText,decision:run.decision})))return true;
 const ids=[run.runId,run.clientRunId,run.sessionId];
 return store.paymentRequests.some((x:any)=>!['confirmed','demo_confirmed','failed','cancelled','expired','blocked'].includes(x?.state)||ids.includes(x?.draft?.origin?.id)||ids.includes(x?.runId))||store.ownerConfirmations.some((x:any)=>x?.intent?.action?.type?.startsWith('payment.')&&(!['consumed','cancelled','expired'].includes(x.state)||ids.includes(x?.intent?.origin?.id)));
}
function activeRuns(store:any,sessions:any[]){
 return store.runs.filter((run:any)=>run.executionSource!=='capability_first'&&run.modality!=='voice'&&!run.result&&!run.error&&(!run.state||run.state==='running')&&
  !(store.archivedSessionIds||[]).includes(run.sessionId)&&!(store.runDeletions||[]).some((x:any)=>x.runId===run.runId)&&sessions.some((session:any)=>
   (session.key??session.sessionKey)===(run.sessionKey||expectedCompanionSessionKey(run.sessionId))&&Array.isArray(session.activeRunIds)&&session.activeRunIds.length===1&&session.activeRunIds[0]===run.runId));
}
function currentToolCall(history:any,id:string){
 if(!Array.isArray(history?.messages)||history.messages.length>200)return false;
 const messages=history.messages.map((x:any)=>x?.message??x);let start=-1;
 for(let i=0;i<messages.length;i++)if(messages[i]?.role==='user')start=i;
 if(start<0)return false;
 const turn=messages.slice(start+1);const calls=turn.flatMap((x:any)=>Array.isArray(x.content)?x.content:[]).filter((x:any)=>x?.type==='toolCall'&&x.id===id);
 return calls.length===1&&!turn.some((x:any)=>x?.role==='toolResult'&&(x.toolCallId===id||x.tool_call_id===id));
}
async function loadSnapshot():Promise<Snapshot>{
 const deadline=Date.now()+20000;
 const read=(method:string,params:Record<string,unknown>={})=>{const remaining=Math.min(RPC_MS,deadline-Date.now());if(remaining<=0)throw failure('approval_read_budget_exceeded',503);return callOpenClawGateway(method,params,{timeoutMs:remaining,hardTimeoutMs:remaining});};
 const store=await registry();
 const [exec,plugin,listed]=await Promise.all([read('exec.approval.list'),read('plugin.approval.list'),read('sessions.list',{search:'companion-',limit:100})]);
 const sessions=Array.isArray(listed)?listed:listed?.sessions;
 if(!Array.isArray(sessions)||sessions.length>100)throw failure('approval_owner_unavailable',503);
 const active=activeRuns(store,sessions),items:Linked[]=[];
 const histories=new Map<string,Promise<any>>();
 const history=(key:string)=>{let found=histories.get(key);if(!found){if(histories.size>=10)return Promise.resolve(null);found=read('chat.history',{sessionKey:key,limit:200});histories.set(key,found);}return found;};
 for(const approval of [...decodePendingApprovals(exec,'exec'),...decodePendingApprovals(plugin,'plugin')]){
  if(Date.now()>=deadline)throw failure('approval_read_budget_exceeded',503);
  let candidates=active.filter((run:any)=>{
   const key=run.sessionKey||expectedCompanionSessionKey(run.sessionId);
   return (approval.sessionKey===key||approval.kind==='plugin'&&!approval.sessionKey)&&(!approval.runId||approval.runId===run.runId);
  });
  if(approval.kind==='plugin'){
   const proven=await Promise.all(candidates.slice(0,10).map(async(run:any)=>approval.toolCallId&&currentToolCall(await history(run.sessionKey||expectedCompanionSessionKey(run.sessionId)),approval.toolCallId)?run:null));
   // Never hide ambiguity by truncating the candidate set.
   candidates=candidates.length>10?[]:proven.filter(Boolean);
  }
  const run=candidates.length===1?candidates[0]:null;
  items.push({...approval,runId:run?.runId||null,reason:approval.reason||(run&&paymentRun(run,store)?'approval_payment_excluded':!run?'approval_run_link_unqualified':null)});
 }
 if(Date.now()>=deadline)throw failure('approval_read_budget_exceeded',503);
 return {items,at:Date.now(),issues:[]};
}
function refresh(){
 if(refreshing)return refreshing;
 refreshing=loadSnapshot().then(value=>{snapshot=value;}).catch(()=>{snapshot={items:[],at:Date.now(),issues:['approval_owner_unavailable']};}).finally(()=>{refreshing=null;});
 return refreshing;
}
function view(item:Linked){return {id:item.id,runId:item.runId,summary:item.kind==='exec'?'Exécution d’un outil en attente d’approbation':'Action d’un plugin en attente d’approbation',tool:item.kind,risk:'high',expiresAt:item.expiresAt,
 decidable:!!item.runId&&!item.reason&&item.expiresAt>Date.now(),reason:item.reason||(item.expiresAt<=Date.now()?'approval_expired':null)};}
/** Read path never waits for the slow CLI; cold/old data explicitly cannot be decided. */
export function readRunApproval(runId:string){
 if(!identifier.test(runId))throw failure('invalid_run_id');
 const stale=Date.now()-snapshot.at>CACHE_MS;
 if(stale)void refresh();
 const matches=snapshot.items.filter(row=>row.runId===runId);
 return {success:!stale&&!snapshot.issues.length,state:stale?'refreshing':snapshot.issues.length?'unavailable':matches.length===1?'pending':matches.length>1?'ambiguous':'none',receipt:null,
  approval:matches.length===1?{...view(matches[0]),...(stale?{decidable:false,reason:'approval_snapshot_stale'}:{})}:null,issues:snapshot.issues,observedAt:snapshot.at||null};
}
const inFlight=new Map<string,Promise<any>>();
function stored(status:any){try{const value=JSON.parse(status.result);if(status.state==='done'&&value.receipt?.runId===status.runId&&value.receipt?.version===1)return value;}catch{}return {success:false,state:'indeterminate',receipt:null};}
export async function decideRunApproval(runId:string,body:any){
 if(!body?.confirmationId)throw failure('confirmation_required',403);
 if(!identifier.test(runId)||!closed(body,['decision','operationId','confirmationId'])||Object.keys(body).length!==3||!['approve','deny'].includes(body.decision)||!operationIdentifier.test(body.operationId||'')||!ownerUuid.test(body.confirmationId||''))throw failure('invalid_approval_operation');
 if(inFlight.has(body.operationId)){await inFlight.get(body.operationId);return decideRunApproval(runId,body);}
 const work=decideOnce(runId,body);inFlight.set(body.operationId,work);
 try{return await work;}finally{if(inFlight.get(body.operationId)===work)inFlight.delete(body.operationId);}
}
async function decideOnce(runId:string,body:any){
 const decision=body.decision==='approve'?'allow-once':'deny';
 const identity=JSON.stringify({action:'agent.approval_decide',runId,decision,confirmationId:body.confirmationId});
 const clientId='approval-operation-'+digest(body.operationId),sessionId='native-owner-actions';
 const old=await findSubmittedRunByClientRunId(clientId,{text:identity,sessionId});
 const oldResult=old?stored(old):null;
 if(oldResult&&oldResult.state!=='failed')return oldResult;
 // Known financial runs are rejected before any Gateway read or biometric consumption.
 const local=await registry(),run=local.runs.find((x:any)=>x.runId===runId);
 if(!run)throw failure('approval_run_not_found',404);
 if(paymentRun(run,local))return {success:false,state:'refused',receipt:null,reason:'approval_payment_excluded'};
 let fresh:Snapshot;
 try{fresh=await loadSnapshot();}catch{return {success:false,state:'failed',receipt:null,error:'approval_owner_unavailable'};}
 snapshot=fresh;
 const candidates=fresh.items.filter(x=>x.runId===runId);
 if(candidates.length!==1)return {success:false,state:'refused',receipt:null,reason:'approval_run_link_unqualified'};
 let approval=candidates[0];
 if(approval.reason)return {success:false,state:approval.reason==='approval_expired'?'expired':approval.reason==='approval_already_decided'?'already_decided':'refused',receipt:null,reason:approval.reason};
 if(approval.expiresAt<=Date.now())return {success:false,state:'expired',receipt:null};
 if(!approval.allowed.includes(decision))return {success:false,state:'refused',receipt:null,reason:'approval_decision_not_allowed'};
 // exec.get is an additional fresh identity/deadline check, never a fallback to another approval.
 if(approval.kind==='exec'){
  let raw:any;try{raw=await rpc('exec.approval.get',{id:approval.id});}catch{return {success:false,state:'failed',receipt:null,error:'approval_owner_unavailable'};}
  if(!closed(raw,['id','commandText','commandPreview','allowedDecisions','host','nodeId','agentId','expiresAtMs'])||raw.id!==approval.id||raw.expiresAtMs!==approval.expiresAt||!Array.isArray(raw.allowedDecisions)||!raw.allowedDecisions.includes(decision))return {success:false,state:'refused',receipt:null,reason:'approval_details_unqualified'};
  const details=JSON.stringify({commandText:raw.commandText,commandPreview:raw.commandPreview});
  if(financial.test(details))return {success:false,state:'refused',receipt:null,reason:'approval_payment_excluded'};
  if(secret.test(details))return {success:false,state:'refused',receipt:null,reason:'approval_sensitive_details'};
  if(!inertCommand({commandText:raw.commandText}))return {success:false,state:'refused',receipt:null,reason:'approval_payment_scope_unqualified'};
 }
 const confirm=await confirmations.status(body.confirmationId);
 const expected:OwnerIntent={audience:'confirmation',action:{type:'agent.approval_decide',reference:approval.id,payloadHash:digest(approval.id+'|'+decision)},presentation:confirm.intent.presentation,origin:confirm.intent.origin};
 // Recheck persisted financial ownership before claiming the operation and consuming proof.
 const latest=await registry();if(paymentRun(latest.runs.find((x:any)=>x.runId===runId)||run,latest))return {success:false,state:'refused',receipt:null,reason:'approval_payment_excluded'};
 if(oldResult){
  if(oldResult.receipt.approvalId!==approval.id||confirm.state!=='consumed'||Date.now()>=confirm.expiresAt||confirm.bindingHash!==ownerBinding(expected))throw failure('confirmation_not_usable',409);
 }else await confirmations.consume(body.confirmationId,expected);
 const reserved=await reserveSubmittedRun(identity,sessionId,clientId,{requestText:identity,executionSource:'capability_first',decision:{version:2,type:'EXECUTE',capability:'agent.approval_decide'}});
 if(!reserved.created&&!oldResult)return stored(reserved.status);
 const pending={success:false,state:'indeterminate',receipt:{version:1,runId:reserved.status.runId,targetRunId:runId,operationId:body.operationId,action:'agent.approval_decide',approvalId:approval.id,decision,state:'indeterminate',at:Date.now()}};
 if(oldResult){if(!await claimFailedApprovalOperation(reserved.status.runId,clientId,identity,JSON.stringify(pending)))return stored(await findSubmittedRunByClientRunId(clientId,{text:identity,sessionId}));}
 else await settleSubmittedRun(reserved.status.runId,'done',JSON.stringify(pending));
 let state='indeterminate';
 if(approval.expiresAt<=Date.now())state='expired';
 else{
  try{const result=await rpc(approval.kind+'.approval.resolve',{id:approval.id,decision});if(closed(result,['ok'])&&result.ok===true)state=decision==='deny'?'denied':'approved';}
  catch(error:any){
   if(['ENOENT','ECONNREFUSED'].includes(error?.code))state='failed';
   else{
   // Absence from pending is not terminal proof. Re-read exactly once, never resolve twice.
   try{const items=decodePendingApprovals(await rpc(approval.kind+'.approval.list'),approval.kind);const item=items.find(x=>x.id===approval.id);
    if(item?.reason==='approval_already_decided'&&item.decided===decision)state=decision==='deny'?'denied':'approved';
   }catch{}
   }
  }
 }
 const result={success:state==='approved'||state==='denied',state,...(state==='failed'?{error:'approval_dispatch_not_started'}:{}),receipt:{version:1,runId:reserved.status.runId,targetRunId:runId,operationId:body.operationId,action:'agent.approval_decide',approvalId:approval.id,decision,state,at:Date.now()}};
 await settleSubmittedRun(reserved.status.runId,'done',JSON.stringify(result));
 void refresh();return result;
}
