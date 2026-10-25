/** L2 owner context, derived by the existing playbooks context producer. No store or semantic routing. */
import {execFileSync} from 'child_process';
import path from 'path';
import os from 'os';
export const OWNER_FOUNDATION_FLAG='SAMANTHA_CONTEXT_FOUNDATION';
export function ownerFoundationEnabled(){return process.env[OWNER_FOUNDATION_FLAG]==='1';}
export function ownerFoundationContext(options:{authority?:'owner';home?:string;read?:(file:string,args:string[])=>string}={}){
 if(options.authority!=='owner')return '';
 const home=options.home||os.homedir();
 const file=path.join(home,'.openclaw','runtime-ui-playbooks','current','tools','context_foundation.py');
 const read=options.read||((f:string,args:string[])=>execFileSync('python3',[f,...args],{encoding:'utf8',timeout:1500,maxBuffer:131072}));
 const value=JSON.parse(read(file,['--home',home]));
 if(value?.version!==1||!/^[a-f0-9]{64}$/.test(value.sha256)||!/^[a-f0-9]{64}$/.test(value.stable_sha256)||
  !Number.isInteger(value.revision)||value.revision<0||!Number.isInteger(value.estimated_tokens)||value.estimated_tokens>6000||
  typeof value.content!=='string'||!Array.isArray(value.skills)||value.skills.length>20)throw Error('owner_foundation_invalid');
 const skills=value.skills.map((row:any)=>{
  if(!/^[a-z][a-z0-9-]{1,79}$/.test(row?.name)||typeof row.description!=='string'||row.description.length>400||
   row.path!==`skills/${row.name}/SKILL.md`)throw Error('owner_foundation_skill_invalid');
  return `${row.name}: ${row.description} (${row.path})`;
 }).join('\n');
 const text=`[SAMANTHA_FOUNDATION v1 sha256=${value.sha256} stable=${value.stable_sha256} revision=${value.revision}]\n${value.instruction}\n\n${value.content}\n\n## Skills à la demande\n${skills}`;
 if(Buffer.byteLength(text)>24000)throw Error('owner_foundation_budget_exceeded');
 return text;
}
/** Only trusted main-agent workspace context admits this hook. Contacts retain their own bootstrap. */
export function ownerFoundationHook(_event:unknown,ctx:any){
 if(!ownerFoundationEnabled()||ctx?.agentId!=='main'||ctx.workspaceDir!==path.join(os.homedir(),'.openclaw','workspace'))return;
 // Companion supplies the same producer's context through its existing extraSystemPrompt path; do not duplicate it.
 if(typeof ctx.sessionKey==='string'&&ctx.sessionKey.startsWith('agent:main:companion-'))return;
 return {prependSystemContext:ownerFoundationContext({authority:'owner'})};
}
