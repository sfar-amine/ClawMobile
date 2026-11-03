/**
 * #126 — host-side progressive disclosure for the owner main agent.
 *
 * S24 02/11 (OpenClaw 2026.10.9): « Qu'est-ce que j'ai dans mon agenda demain ? » spent about 8 s of a 17 s first turn
 * discovering its skill (tool_search, then skills_read, each a model round trip). When the current owner request
 * clearly belongs to one frequent typed domain, the installed SKILL.md body is added to THIS turn only
 * (before_prompt_build `prependContext`, model-facing and not persisted), never to the cached system prefix.
 *
 * Deterministic and cheap: a closed trigger table, no model call, no process spawn; one stat (and a read when the
 * file changed) per matched turn. Several domains or none: nothing is injected and normal discovery stays.
 * Every failure is fail-open to nothing.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const SKILL_PRELOAD_FLAG='SAMANTHA_SKILL_PRELOAD';
/** Kill switch: on by default, `SAMANTHA_SKILL_PRELOAD=0` in the owner env disables it (rollback without deploy). */
export function skillPreloadEnabled(){return process.env[SKILL_PRELOAD_FLAG]!=='0';}
/** Largest installed skill on 02/11 is samantha-factures (12 068 bytes); a larger file is never injected. */
export const SKILL_PRELOAD_MAX_BYTES=16384;
/** Owner requests are short; a long text (pasted document, engineering brief) is not a clear typed request. */
export const SKILL_PRELOAD_MAX_REQUEST_CHARS=1200;
/** A domain is clear at this score, and only when no other domain scores at all. */
const CLEAR_SCORE=2;

type Trigger=readonly [phrase:string,weight:1|2];
/**
 * Closed trigger table (FR, Tunisian derja in Latin letters, EN). Phrases are compared on whole words after
 * normalisation (lower case, no accents, punctuation as spaces): « rendez-vous » is `rendez vous`, « d'écran » is
 * `d ecran`. Weight 2 is a domain word on its own; weight 1 needs a second word of the same domain.
 */
export const SKILL_TRIGGERS:Readonly<Record<string,readonly Trigger[]>>={
 'samantha-agenda':[
  ['agenda',2],['ajenda',2],['calendrier',2],['calendar',2],['rendez vous',2],['rendezvous',2],['rdv',2],['rdvs',2],
  ['appointment',2],['appointments',2],['reunion',2],['reunions',2],['meeting',2],['meetings',2],
  ['maw3ed',2],['maw3id',2],['mawa3ed',2],['mawa3id',2],['mw3ed',2],
  ['evenement',1],['evenements',1],['event',1],['events',1],['planning',1],
 ],
 'samantha-factures':[
  ['facture',2],['factures',2],['steg',2],['sonede',2],['topnet',2],['impaye',2],['impayes',2],
  ['fatoura',2],['fatoora',2],['fatourat',2],['fatouret',2],['bill',2],['bills',2],['invoice',2],['invoices',2],
  ['electricite',1],['kahraba',1],
 ],
 'orange-telecom':[
  ['maxit',2],['tunisie telecom',2],['zain',2],
  ['orange',1],['solde',1],['soldes',1],['forfait',1],['forfaits',1],['balance',1],['rased',1],['rasid',1],['rassid',1],
  ['credit',1],['data',1],['internet',1],['puce',1],['ligne',1],['mega',1],['megas',1],
 ],
 'samantha-appareil':[
  ['torche',2],['torch',2],['flashlight',2],['ne pas deranger',2],['do not disturb',2],['dnd',2],
  ['minuteur',2],['minuteurs',2],['timer',2],['timers',2],['alarme',2],['alarmes',2],['alarm',2],['alarms',2],
  ['reveil',2],['reveille moi',2],['wake me',2],['fi9ni',2],['fay9ni',2],
  ['luminosite',2],['brightness',2],['sonnerie',2],['ringer',2],['vibreur',2],['vibrate',2],['silencieux',2],['silent mode',2],
  ['bluetooth',2],['wifi',2],['wi fi',2],['screenshot',2],['capture d ecran',2],['captures d ecran',2],
  ['batterie',2],['battery',2],['economie d energie',2],['battery saver',2],['volume',2],
  ['dernier sms',2],['derniers sms',2],['last sms',2],['latest sms',2],['combien de photos',2],
  ['sms',1],['photo',1],['photos',1],
 ],
};
/** Engineering, Pulse and skill-maintenance words: never a typed owner request, discovery stays. */
const EXCLUSIONS:readonly string[]=['pulse','skill','skills','skill md','playbook','playbooks','commit','commits','pull request',
 'deploy','deploie','deployer','deploiement','recette','capability','capabilities','claude','codex'];

export function normalizeRequest(text:string){
 return ' '+text.normalize('NFD').replace(/\p{M}+/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()+' ';
}
const has=(normalized:string,phrase:string)=>normalized.includes(' '+phrase+' ');

/** The owner's words only: transport prefixes ([Mon 2026-11-02 10:00 GMT+1] [companion-session:x]) and fenced
 * untrusted metadata blocks are not part of the request. */
export function ownerRequestText(prompt:unknown){
 if(typeof prompt!=='string')return '';
 return prompt.replace(/^[^\n]*\(untrusted[^\n]*\):?\s*\n```[^\n]*\n[\s\S]*?\n```\s*/gm,'')
  .replace(/^(?:\s*\[[^\]\n]{0,160}\])+\s*/,'').trim();
}

/** Single clear typed domain of an owner request, or null (none, several, excluded or too long). */
export function matchSkill(prompt:unknown):string|null{
 const request=ownerRequestText(prompt);
 if(!request||request.length>SKILL_PRELOAD_MAX_REQUEST_CHARS)return null;
 const normalized=normalizeRequest(request);
 if(EXCLUSIONS.some(word=>has(normalized,word)))return null;
 const scored=Object.entries(SKILL_TRIGGERS)
  .map(([name,triggers])=>[name,triggers.reduce((sum,[phrase,weight])=>sum+(has(normalized,phrase)?weight:0),0)] as const)
  .filter(([,score])=>score>0);
 return scored.length===1&&scored[0][1]>=CLEAR_SCORE?scored[0][0]:null;
}

type CachedSkill={mtimeMs:number;size:number;body:string|null};
const cache=new Map<string,CachedSkill>();
/** Bounded by the closed table: at most one entry per known skill file. */
function installedSkill(workspaceDir:string,name:string):string|null{
 const file=path.join(workspaceDir,'skills',name,'SKILL.md');
 const stat=fs.statSync(file);
 if(!stat.isFile()||stat.size>SKILL_PRELOAD_MAX_BYTES)return null;
 const hit=cache.get(file);
 if(hit&&hit.mtimeMs===stat.mtimeMs&&hit.size===stat.size)return hit.body;
 const buffer=Buffer.alloc(SKILL_PRELOAD_MAX_BYTES+1);
 const fd=fs.openSync(file,'r');
 let length=0;
 try{length=fs.readSync(fd,buffer,0,buffer.length,0);}finally{fs.closeSync(fd);}
 const text=length>SKILL_PRELOAD_MAX_BYTES?'':buffer.subarray(0,length).toString('utf8');
 // The installed file must be the skill it claims to be (frontmatter written by the playbooks activation).
 const body=text&&new RegExp('^---\\nname: '+name+'\\n').test(text)&&!text.includes('\u0000')?text:null;
 cache.set(file,{mtimeMs:stat.mtimeMs,size:stat.size,body});
 return body;
}

export function skillPreloadBlock(name:string,body:string){
 const sha=crypto.createHash('sha256').update(body).digest('hex').slice(0,16);
 return `[SAMANTHA_SKILL_PRELOAD name=${name} sha256=${sha}]\n`+
  `Instructions du skill ${name} déjà chargées pour ce tour : ne pas les relire (ni skills_read, ni read de skills/${name}/SKILL.md). Elles s'appliquent à la demande ci-dessous.\n\n`+
  `${body.trimEnd()}\n[/SAMANTHA_SKILL_PRELOAD]`;
}

/** Per-turn context for an already-admitted owner main-agent turn; the caller checks the owner workspace. */
export function ownerSkillPreload(event:any,ctx:any):string|undefined{
 try{
  if(!skillPreloadEnabled())return;
  // Cron, heartbeat, subagent and inter-session/system inputs are not the owner's own request.
  if(ctx?.trigger!==undefined&&ctx.trigger!=='user')return;
  if(typeof ctx?.sessionKey==='string'&&/:(cron|subagent):/.test(ctx.sessionKey))return;
  const provenance=ctx?.inputProvenance?.kind;
  if(provenance!==undefined&&provenance!=='external_user')return;
  const name=matchSkill(event?.prompt);
  if(!name||typeof ctx?.workspaceDir!=='string')return;
  const body=installedSkill(ctx.workspaceDir,name);
  return body?skillPreloadBlock(name,body):undefined;
 }catch{return;}
}
