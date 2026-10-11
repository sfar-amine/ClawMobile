import {execFile} from 'child_process';
import {createHash} from 'crypto';
import {controlPaths,readControlProjection} from './control';

const MAX_BYTES=256*1024;
const fail=()=>Object.assign(new Error('catalog_source_unavailable'),{statusCode:503});
/** HS1 presentation is not evidence that its route is currently reachable. */
export function catalogProjection(source:any):any {
  if(!source||source.version!==1||!['fr','en'].includes(source.locale)||!Array.isArray(source.themes)||!source.themes.length||source.themes.length>32||!Array.isArray(source.defaultPinned)||source.defaultPinned.length>6||typeof source.generatedAt!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/.test(source.generatedAt)||!Number.isFinite(Date.parse(source.generatedAt)))throw fail();
  let count=0,totalGroups=0;const themeIds=new Set<string>(),actionIds=new Set<string>();
  const text=(v:any,max=200)=>{if(typeof v!=='string'||v.length>max||/[\u0000-\u001f]/.test(v))throw fail();return v;};
  const id=(v:any)=>{if(typeof v!=='string'||! /^[a-z0-9_.-]{1,160}$/.test(v))throw fail();return v;};
  const themes=source.themes.map((theme:any)=>{
    if(!theme||!Number.isInteger(theme.order)||theme.order<0||theme.order>128||!Array.isArray(theme.groups)||!theme.groups.length||theme.groups.length>128)throw fail();
    const themeId=id(theme.id);if(themeIds.has(themeId))throw fail();themeIds.add(themeId);const groupIds=new Set<string>();
    const groups=theme.groups.map((group:any)=>{
      if(++totalGroups>128||!group||!Array.isArray(group.actions)||!group.actions.length||group.actions.length>128)throw fail();
      const groupId=id(group.id);if(groupIds.has(groupId))throw fail();groupIds.add(groupId);
      const actions=group.actions.map((a:any)=>{
        if(!a||++count>512||!['info','edit','pay','transfer','run','device'].includes(a.kind)||!Array.isArray(a.slots)||a.slots.length>8)throw fail();
        const actionId=id(a.id);if(actionIds.has(actionId)||!actionId.startsWith(themeId+'.'+groupId+'.'))throw fail();actionIds.add(actionId);
        const slotIds=new Set<string>();
        const backed=a.capability!==null;const capability=backed?id(a.capability):null;
        if(backed&&!['read','read_only','write','transaction','payment','high','external','external_send','human','sensitive','destructive','unknown'].includes(a.risk))throw fail();
        // The current CLI has no attested Graph/health/gate inputs. It must not arm actions.
        const reason=backed?'readiness_evidence_unavailable':'in_development';
        return {id:actionId,capability,title:text(a.title),kind:a.kind,slots:a.slots.map((s:any)=>{if(!s||typeof s.required!=='boolean')throw fail();const slotId=id(s.id);if(slotIds.has(slotId))throw fail();slotIds.add(slotId);return {id:slotId,required:s.required};}),request:null,risk:backed&&['pay','transfer'].includes(a.kind)?'transaction':backed?text(a.risk,32):'unknown',confirmationRequired:['pay','transfer'].includes(a.kind)?true:typeof a.confirmationRequired==='boolean'?a.confirmationRequired:null,available:false,availability:backed?'unavailable':'soon',reason,informationIcon:'info',information:source.locale==='fr'?(backed?'Indisponible pour l’instant':'En cours de développement'):(backed?'Currently unavailable':'In development'),...(a.intent?{intent:id(a.intent)}:{})};
      });
      return {id:groupId,title:text(group.title),icon:id(group.icon),actions};
    });
    return {id:themeId,title:text(theme.title),subtitle:text(theme.subtitle),icon:id(theme.icon),example:text(theme.example),order:theme.order,groups,available:false,availability:groups.every((g:any)=>g.actions.every((a:any)=>a.capability===null))?'soon':'unavailable'};
  });
  const defaultPinned=source.defaultPinned.map(id);if(new Set(defaultPinned).size!==defaultPinned.length||defaultPinned.some((pin:string)=>!themeIds.has(pin)))throw fail();
  const value={version:1,locale:source.locale,defaultPinned,themes,generatedAt:source.generatedAt,inputs:{voiceMemo:false},badges:[],availabilitySource:'canonical_presentation_readiness_unverified'};
  if(Buffer.byteLength(JSON.stringify(value))>MAX_BYTES)throw fail();
  return value;
}
export async function readCatalog(locale:'fr'|'en',signal?:AbortSignal):Promise<any>{
  const root=controlPaths().playbooks;
  return readControlProjection('catalog:'+JSON.stringify([root,locale]),async abort=>{
    const source=await new Promise<any>((resolve,reject)=>execFile('python3',['-m','reporting.control_capability','--catalog','--locale',locale],{cwd:root,timeout:6000,maxBuffer:MAX_BYTES,signal:abort},(error,stdout)=>{
      if(error){reject(fail());return;}try{resolve(JSON.parse(stdout));}catch{reject(fail());}
    }));
    if(source?.locale!==locale)throw fail();
    return catalogProjection(source);
  },signal);
}
export function catalogETag(value:any):string{return '"'+createHash('sha256').update(JSON.stringify(value)).digest('hex')+'"';}

/** A cold owner read stays shared in Control; HTTP never invents catalogue entries while it computes. */
export async function readCatalogResponse(locale:'fr'|'en'):Promise<any>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const pending={version:1,locale,availability:'unavailable',reason:'catalog_computation_pending',inputs:{voiceMemo:false},computation:{deliveryMode:'deferred',retryAfterMs:250}};
  try{return await Promise.race([readCatalog(locale),new Promise(resolve=>{timer=setTimeout(()=>resolve(pending),200);})]);}
  finally{if(timer)clearTimeout(timer);}
}
