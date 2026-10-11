import {createHash} from 'crypto';
import fs from 'fs/promises';
import {constants} from 'fs';
import pathModule from 'path';
import {ownerUuid} from './ownerConfirmationProtocol';
import type {OwnerIntent} from './ownerConfirmationProtocol';
import {MASKED_LINE,protectedFileLine} from './fileReadBoundary';
import {callOpenClawGateway} from './openclawAgentClient';
import {confirmations} from './confirmations';
import {nativeOperation,existingNativeOperation} from './nativeOperation';
import {invalidateFileReads} from './fileReads';

// E3 / R20 lot 2: PUT /v1/files/content?scope=agent&path=NAME through the installed agents.files.set owner
// (schema + handler read on the S24, fixtures/s24-2026-10-11b/e3, PR #131). The Gateway offers an atomic CAS
// (expectedHash) between agents.files.set calls of one process, but no content guard and no backup: both are here.
// DREAMS.md is outside the Gateway allowlist (agents.files.get answers unsupported file), MEMORY.md/BOOTSTRAP.md
// are personal memory/bootstrap material: neither is writable from the app.
export const AGENT_EDIT_NAMES=Object.freeze(['AGENTS.md','SOUL.md','USER.md','IDENTITY.md'] as const);
export const AGENT_FILE_BACKUPS=5;
const WRITE_BYTES=256*1024; // same bound as the read preview: the owner approves bytes it could fully see
const fail=(code:string,statusCode=400):never=>{throw Object.assign(new Error(code),{statusCode});};
const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export type AgentFileWritePlan={name:string;content:string;baseHash:string;operationId:string;confirmationId?:string;action:{type:'agent.file_write';reference:string;payloadHash:string}};

/** Pure input validation; payloadHash binds exactly the bytes the owner saw and sent (masked lines included). */
export function prepareAgentFileWrite(name:any,value:any):AgentFileWritePlan {
 const keys=['content','baseHash','operationId','confirmationId'];
 if(!object(value)||Object.keys(value).some(k=>!keys.includes(k))||['content','baseHash','operationId'].some(k=>!Object.prototype.hasOwnProperty.call(value,k)))fail('invalid_file_write');
 if(typeof name!=='string'||!(AGENT_EDIT_NAMES as readonly string[]).includes(name))fail('file_write_not_available',404);
 if(typeof value.content!=='string'||value.content.includes('\0')||Buffer.byteLength(value.content,'utf8')>WRITE_BYTES||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value.content))fail('invalid_file_content');
 if(typeof value.baseHash!=='string'||!/^[a-f0-9]{64}$/.test(value.baseHash))fail('invalid_file_revision');
 if(typeof value.operationId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(value.operationId))fail('invalid_operation_id');
 if('confirmationId' in value&&(typeof value.confirmationId!=='string'||!ownerUuid.test(value.confirmationId)))fail('confirmation_mismatch',403);
 return {name,content:value.content,baseHash:value.baseHash,operationId:value.operationId,...(value.confirmationId?{confirmationId:value.confirmationId}:{}),
  action:{type:'agent.file_write',reference:name,payloadHash:sha256(value.content)}};
}

/**
 * Payment/secret instruction guard. The app edits the masked preview: each `[masqué]` line stands for one protected
 * line of the current file, in order. Those lines are restored verbatim; they can be neither edited, removed,
 * reordered nor added. Any other protected line in the submission (new payment or secret instruction) is refused.
 */
export function mergeProtectedLines(current:string,submitted:string):string {
 const protectedLines=current.split(/\r?\n/).filter(protectedFileLine);
 const eol=/\r\n/.test(current)?'\r\n':'\n';
 const lines=submitted.split(/\r?\n/);
 if(lines.some(line=>line!==MASKED_LINE&&(protectedFileLine(line)||line.includes(MASKED_LINE))))fail('file_content_protected',422);
 const masked=lines.filter(line=>line===MASKED_LINE).length;
 if(masked!==protectedLines.length)fail('file_protected_lines_changed',422);
 let next=0;
 const merged=lines.map(line=>line===MASKED_LINE?protectedLines[next++]:line).join(eol);
 // Defence in depth: the protected sequence of the result is exactly the current one.
 const after=merged.split(/\r?\n/).filter(protectedFileLine);
 if(after.length!==protectedLines.length||after.some((line,i)=>line!==protectedLines[i]))fail('file_protected_lines_changed',422);
 return merged;
}

type Current={workspace:string;path:string;content:string;hash:string};
async function readCurrent(name:string):Promise<Current>{
 let value:any;
 try{value=await callOpenClawGateway('agents.files.get',{agentId:'main',name},{timeoutMs:10000,hardTimeoutMs:12000,strictOutput:{stdoutMaxBytes:4*1024*1024,stderrMaxBytes:64*1024,killGraceMs:250}});}
 catch{return fail('files_owner_unavailable',503);}
 const file=value?.file;
 if(!object(value)||value.agentId!=='main'||typeof value.workspace!=='string'||!pathModule.isAbsolute(value.workspace)||!object(file)||file.name!==name)fail('files_owner_unavailable',503);
 // A missing file has no revision: the Gateway would refuse any expectedHash, so the app cannot create one here.
 if(file.missing!==false)fail('file_not_available',404);
 const workspace=pathModule.normalize(value.workspace).replace(/\/$/,'');
 if(typeof file.content!=='string'||typeof file.hash!=='string'||file.path!==workspace+'/'+name)fail('files_owner_unavailable',503);
 if(sha256(file.content)!==file.hash.toLowerCase())fail('files_owner_unavailable',503);
 return {workspace,path:file.path,content:file.content,hash:file.hash.toLowerCase()};
}

const backupPattern=(name:string)=>new RegExp('^'+name.replace('.','\\.')+'\\.bak-samantha-\\d{8}T\\d{9}Z$');
/**
 * Bounded backup of the version being replaced, beside it in the agent workspace, following the existing
 * `<NAME>.bak-*` convention (hidden from the file reads by fileReadBoundary). No new store: at most five per file.
 */
export async function backupAgentFile(current:Current,name:string,now=new Date()):Promise<string>{
 const info=await fs.lstat(current.workspace);if(!info.isDirectory()||info.isSymbolicLink())fail('file_backup_unavailable',503);
 const stamp=now.toISOString().replace(/[-:.]/g,'');
 const backup=pathModule.join(current.workspace,`${name}.bak-samantha-${stamp}`);
 let handle:fs.FileHandle|undefined;
 try{handle=await fs.open(backup,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(current.content,'utf8');await handle.sync();}
 catch(error:any){if(error?.statusCode)throw error;fail('file_backup_unavailable',503);}
 finally{await handle?.close();}
 await pruneAgentFileBackups(current.workspace,name);
 return pathModule.basename(backup);
}
export async function pruneAgentFileBackups(workspace:string,name:string,keep=AGENT_FILE_BACKUPS){
 const pattern=backupPattern(name);
 const entries=(await fs.readdir(workspace,{withFileTypes:true})).filter(e=>e.isFile()&&pattern.test(e.name)).map(e=>e.name).sort();
 for(const old of entries.slice(0,Math.max(0,entries.length-keep)))await fs.unlink(pathModule.join(workspace,old)).catch(()=>undefined);
}

const conflict=(error:any)=>error?.details?.type==='agent_file_conflict'||/changed since it was read/.test(String(error?.message||''));
/**
 * Order: input and name, owner read, CAS precheck, payment/secret guard, confirmation challenge, then one
 * durable native operation: confirmation consumed, backup, single agents.files.set with expectedHash, one re-read
 * if the answer is uncertain, never a replay.
 */
export async function writeAgentFile(name:any,body:any){
 const plan=prepareAgentFileWrite(name,body);
 const existing=await existingNativeOperation(plan.operationId,JSON.stringify({action:'agent.file_write',target:plan.name}));
 if(existing)return existing;
 const current=await readCurrent(plan.name);
 if(current.hash!==plan.baseHash)return {success:false,state:'refused',receipt:null,error:'file_revision_changed',currentRevision:current.hash};
 const merged=mergeProtectedLines(current.content,plan.content);
 if(Buffer.byteLength(merged,'utf8')>2*1024*1024)fail('invalid_file_content');
 if(merged===current.content)return {success:true,state:'unchanged',receipt:null,revision:current.hash};
 if(!plan.confirmationId)return {success:false,state:'needs_confirmation',receipt:null,error:'confirmation_required',scope:plan.action.type,reference:plan.action.reference,payloadHash:plan.action.payloadHash};
 const result=await nativeOperation(plan.operationId,'agent.file_write',plan.name,async()=>{
  try{
   const record=await confirmations.status(plan.confirmationId!);
   const expected:OwnerIntent={audience:'confirmation',action:plan.action,presentation:record.intent.presentation,origin:record.intent.origin};
   // Core verifies the exact binding and the biometric proof, then claims single use durably.
   await confirmations.consume(plan.confirmationId!,expected);
  }catch(error:any){
   if([400,403,404,409].includes(error?.statusCode))return {state:'refused',artifact:{reason:'confirmation_not_usable'}};
   throw error;
  }
  let backup:string;
  try{backup=await backupAgentFile(current,plan.name);}catch{return {state:'refused',artifact:{reason:'file_backup_unavailable'}};}
  let response:any,setError:any;
  try{response=await callOpenClawGateway('agents.files.set',{agentId:'main',name:plan.name,content:merged,expectedHash:plan.baseHash},{timeoutMs:10000,hardTimeoutMs:12000});}
  catch(error:any){setError=error;}
  const target=sha256(merged);
  if(!setError&&response?.ok===true&&response.file?.name===plan.name&&String(response.file?.hash).toLowerCase()===target)
   return {state:'completed',artifact:{revision:target,backup}};
  if(setError&&conflict(setError))return {state:'refused',artifact:{reason:'file_revision_changed'}};
  // Uncertain outcome: one owner re-read, never a second write.
  const after=await readCurrent(plan.name);
  if(after.hash===target)return {state:'completed',artifact:{revision:target,backup}};
  if(after.hash===plan.baseHash)return {state:'refused',artifact:{reason:'file_write_not_applied'}};
  return {state:'refused',artifact:{reason:'file_revision_changed'}};
 });
 if((result as any)?.state==='completed')invalidateFileReads();
 return result;
}
