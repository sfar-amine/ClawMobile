/** L2 owner context, derived by the existing playbooks context producer. No store or semantic routing. */
import {execFileSync} from 'child_process';
import path from 'path';
import os from 'os';
import {ownerSkillPreload} from './ownerSkillPreload';
export const OWNER_FOUNDATION_FLAG='SAMANTHA_CONTEXT_FOUNDATION';
export function ownerFoundationEnabled(){return process.env[OWNER_FOUNDATION_FLAG]==='1';}
type FoundationOptions={authority?:'owner';home?:string;read?:(file:string,args:string[])=>string};
// Same 8000-token L2 ceiling as the producer and the MCP transport (32000 UTF-8 bytes, Amine 28/10/2026).
const FOUNDATION_MAX_TOKENS=8000;
const FOUNDATION_MAX_BYTES=32000;
// OpenClaw already injects these workspace files, in full, in the Project Context of an interactive main-agent turn.
const BOOTSTRAP_IN_PROJECT_CONTEXT='SOUL.md et AGENTS.md : texte intégral dans le Project Context de ce prompt.';
function produce(options:FoundationOptions,args:string[]){
 const home=options.home||os.homedir();
 const file=path.join(home,'.openclaw','runtime-ui-playbooks','current','tools','context_foundation.py');
 const read=options.read||((f:string,a:string[])=>execFileSync('python3',[f,...a],{encoding:'utf8',timeout:1500,maxBuffer:131072,stdio:['ignore','pipe','ignore']}));
 return JSON.parse(read(file,['--home',home,...args]));
}
function validated(value:any,version:number){
 if(value?.version!==version||!/^[a-f0-9]{64}$/.test(value.sha256)||!/^[a-f0-9]{64}$/.test(value.stable_sha256)||
  !Number.isInteger(value.revision)||value.revision<0||!Number.isInteger(value.estimated_tokens)||value.estimated_tokens>FOUNDATION_MAX_TOKENS||
  typeof value.instruction!=='string'||!Array.isArray(value.skills)||value.skills.length>20)throw Error('owner_foundation_invalid');
 return value;
}
function skillIndex(value:any){
 return value.skills.map((row:any)=>{
  if(!/^[a-z][a-z0-9-]{1,79}$/.test(row?.name)||typeof row.description!=='string'||row.description.length>400||
   row.path!==`skills/${row.name}/SKILL.md`)throw Error('owner_foundation_skill_invalid');
  return `${row.name}: ${row.description} (${row.path})`;
 }).join('\n');
}
function bounded(text:string){
 if(Buffer.byteLength(text)>FOUNDATION_MAX_BYTES)throw Error('owner_foundation_budget_exceeded');
 return text;
}
export function ownerFoundationContext(options:FoundationOptions={}){
 if(options.authority!=='owner')return '';
 const value=validated(produce(options,[]),1);
 if(typeof value.content!=='string')throw Error('owner_foundation_invalid');
 // Keep changing memory hashes and revision after the stable rules and skill index: provider prefix caches
 // cannot reuse the otherwise identical foundation when the first token changes with every memory event.
 return bounded(`[SAMANTHA_FOUNDATION v1 stable=${value.stable_sha256}]\n${value.instruction}\n\n## Skills à la demande\n${skillIndex(value)}\n\n${value.content}\n\n[SAMANTHA_MEMORY sha256=${value.sha256} revision=${value.revision}]`);
}
export type OwnerFoundationParts={stable:string;memory:string};
/**
 * Prompt-cache layout (Amine 28/10): a provider reuses an exact prompt prefix only, so the stable rules open the
 * system prompt and the memory view, which changes with every memory event, closes it, just before the history.
 * Not with the current turn: OpenClaw does not persist that context, so the next turn's history would no longer
 * match the request just sent and the cache chain would break at every turn (S24 28/10, 14 976 cached tokens per
 * first call instead of 63 232). Returns null while the active producer predates the split layout: callers then
 * keep the single block above, unchanged.
 */
export function ownerFoundationParts(options:FoundationOptions&{bootstrapInProjectContext?:boolean}={}):OwnerFoundationParts|null{
 if(options.authority!=='owner')return null;
 let raw:any;
 try{raw=produce(options,['--layout','split']);}catch{return null;}
 if(raw?.version===1)return null;
 const value=validated(raw,2);
 if(value.layout!=='split'||typeof value.bootstrap!=='string'||typeof value.essential!=='string'||typeof value.memory!=='string')
  throw Error('owner_foundation_invalid');
 const bootstrap=options.bootstrapInProjectContext===true?BOOTSTRAP_IN_PROJECT_CONTEXT:value.bootstrap;
 const stable=`[SAMANTHA_FOUNDATION v1 stable=${value.stable_sha256}]\n${value.instruction}\n\n## Skills à la demande\n${skillIndex(value)}\n\n${bootstrap}\n\n${value.essential}`;
 const memory=`[SAMANTHA_MEMORY sha256=${value.sha256} revision=${value.revision}]\n${value.memory}`;
 bounded(stable+'\n\n'+memory);
 return {stable,memory};
}
/** OpenClaw gives cron and subagent sessions the minimal prompt, without SOUL.md; heartbeats carry their own context. */
export function projectContextHasBootstrap(ctx:any){
 return ctx?.trigger==='user'&&typeof ctx.sessionKey==='string'&&!/:(cron|subagent):/.test(ctx.sessionKey);
}
/** Only trusted main-agent workspace context admits this hook. Contacts retain their own bootstrap. */
export function ownerFoundationHook(event:unknown,ctx:any){
 if(ctx?.agentId!=='main'||ctx.workspaceDir!==path.join(os.homedir(),'.openclaw','workspace'))return;
 // #126: the clear typed domain's SKILL.md for this turn only (prependContext, after the cached system prefix).
 const preload=ownerSkillPreload(event,ctx);
 const foundation=ownerFoundationEnabled()?ownerFoundationSystemContext(ctx):undefined;
 return preload?{...foundation,prependContext:preload}:foundation;
}
function ownerFoundationSystemContext(ctx:any){
 const companion=typeof ctx.sessionKey==='string'&&ctx.sessionKey.startsWith('agent:main:companion-');
 const parts=ownerFoundationParts({authority:'owner',bootstrapInProjectContext:!companion&&projectContextHasBootstrap(ctx)});
 // Companion supplies the stable part (or, with an older producer, the whole block) through its existing
 // extraSystemPrompt path; do not duplicate it.
 if(companion)return parts?{appendSystemContext:parts.memory}:undefined;
 if(!parts)return {prependSystemContext:ownerFoundationContext({authority:'owner'})};
 return {prependSystemContext:parts.stable,appendSystemContext:parts.memory};
}
