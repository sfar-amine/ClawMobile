import {execFile} from 'child_process';
import {createHash} from 'crypto';
import {readFile} from 'fs/promises';
import os from 'os';
import path from 'path';
import {controlPaths,readControlProjection} from './control';

/**
 * HS2 — GET /v1/catalog: a derived view, compiled from the canonical registry (HS1 `catalog()`), the
 * installed route-health snapshot, the compiled capability view of the app surface and the payment owner's
 * own gate projection. Like ~/.openclaw/capability-views it has no state of its own: a bounded cache only.
 * It never reads a supplier, never switches network, never runs the Graph nor an executor.
 */
const MAX_BYTES=256*1024;
const APP_SURFACE='samantha_android';
const STALE_MAX_MS=10*60_000;
const REACHABLE=new Set(['native','delegated']);
// Deterministic payment routes are governed by their owner gate, not by surface views (status experimental).
const GATED_PAYMENT_CAPABILITY='payment.owner_native';
const fail=()=>Object.assign(new Error('catalog_source_unavailable'),{statusCode:503});
const stateDir=()=>process.env.OPENCLAW_STATE_DIR||path.join(os.homedir(),'.openclaw');

/** HS1 `catalog()` with the installed route health and owner gate evidence injected (read-only). */
const HS1_SCRIPT=[
  'import json,sys',
  'from reporting.control_capability import catalog',
  'locale,health_path,gates=sys.argv[1],sys.argv[2],json.loads(sys.argv[3])',
  'try:',
  ' f=open(health_path,encoding="utf-8")',
  'except FileNotFoundError:',
  ' health=None',
  'else:',
  ' with f:health=json.load(f)',
  'print(json.dumps(catalog(locale,route_health=health,gates=gates),ensure_ascii=False))',
].join('\n');

export type GateEvidence=Record<string,{armed:true;source:'canonical_owner';expiresAt:number}>;
export type SurfaceView={version:1;surface:string;capabilities:{id:string;reachability:string}[]}|null;

/** Only the payment owner's own projection arms a gate; an HTTP or model value never does. */
export function ownerGateEvidence(capabilities:any,nowMs=Date.now()):GateEvidence{
  const gates:GateEvidence={};
  const adapters=Array.isArray(capabilities?.adapters)?capabilities.adapters:[];
  const expiresAt=Math.floor(nowMs/1000)+120;
  // maxit.topup: localOwnerValidated mirrors the armed live-acceptance gate (read at start, re-read at execution).
  if(adapters.some((a:any)=>a?.id==='maxit.topup'&&a.mode==='live'&&a.localOwnerValidated===true))
    gates['maxit.topup']={armed:true,source:'canonical_owner',expiresAt};
  // topnet.payment: its one-shot gate is not projected by the owner (localOwnerValidated is constant), so it stays unproven.
  return gates;
}

export function parseSurfaceView(raw:any):SurfaceView{
  if(!raw||raw.version!==1||raw.surface!==APP_SURFACE||!Array.isArray(raw.capabilities)||raw.capabilities.length>2000)return null;
  const rows=raw.capabilities.filter((c:any)=>c&&typeof c.id==='string'&&typeof c.reachability==='string').map((c:any)=>({id:c.id,reachability:c.reachability}));
  return {version:1,surface:APP_SURFACE,capabilities:rows};
}

const unavailableText=(locale:string)=>locale==='fr'?'Indisponible pour l’instant':'Currently unavailable';

/** Validates the HS1 projection, keeps its availability and greys what the app surface cannot reach. */
export function catalogProjection(source:any,view:SurfaceView):any {
  if(!source||source.version!==1||!['fr','en'].includes(source.locale)||!Array.isArray(source.themes)||!source.themes.length||source.themes.length>32||!Array.isArray(source.defaultPinned)||source.defaultPinned.length>9||typeof source.generatedAt!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/.test(source.generatedAt)||!Number.isFinite(Date.parse(source.generatedAt)))throw fail();
  const locale=source.locale as 'fr'|'en';
  const reach=new Map((view?.capabilities||[]).map(c=>[c.id,c.reachability]));
  let count=0,totalGroups=0;const themeIds=new Set<string>(),actionIds=new Set<string>();
  const text=(v:any,max=200)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u001f]/.test(v))throw fail();return v;};
  const id=(v:any)=>{if(typeof v!=='string'||!/^[a-z0-9_.-]{1,160}$/.test(v))throw fail();return v;};
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
        const slots=a.slots.map((s:any)=>{if(!s||typeof s.required!=='boolean')throw fail();const slotId=id(s.id);if(slotIds.has(slotId))throw fail();slotIds.add(slotId);return {id:slotId,required:s.required};});
        const capability=a.capability===null?null:id(a.capability);
        let available=a.available===true&&capability!==null;
        let reason:string|null=available?null:(typeof a.reason==='string'?id(a.reason):capability===null?'in_development':'unavailable');
        if(available){
          const r=reach.get(capability!);
          if(!view){available=false;reason='reachability_unknown';}
          else if(r!==undefined&&!REACHABLE.has(r)){available=false;reason='capability_unreachable';}
          else if(r===undefined&&capability!==GATED_PAYMENT_CAPABILITY){available=false;reason='capability_unreachable';}
        }
        const request=available?text(a.request,400):null;
        const money=['pay','transfer'].includes(a.kind);
        return {id:actionId,capability,title:text(a.title),kind:a.kind,slots,request,
          risk:typeof a.risk==='string'?id(a.risk):'unknown',confirmationRequired:money?true:typeof a.confirmationRequired==='boolean'?a.confirmationRequired:null,
          available,availability:available?'available':reason==='in_development'?'soon':'unavailable',reason,
          informationIcon:available?null:'info',
          information:available?null:reason==='in_development'?(locale==='fr'?'En cours de développement':'In development'):unavailableText(locale),
          ...(typeof a.intent==='string'?{intent:id(a.intent)}:{})};
      });
      return {id:groupId,title:text(group.title),icon:id(group.icon),actions};
    });
    const all=groups.flatMap((g:any)=>g.actions);const available=all.some((a:any)=>a.available);
    return {id:themeId,title:text(theme.title),subtitle:text(theme.subtitle),icon:id(theme.icon),example:text(theme.example),order:theme.order,groups,
      available,availability:available?'available':all.every((a:any)=>a.reason==='in_development')?'soon':'unavailable'};
  });
  const defaultPinned=source.defaultPinned.map(id);if(new Set(defaultPinned).size!==defaultPinned.length||defaultPinned.some((pin:string)=>!themeIds.has(pin)))throw fail();
  const value={version:1,locale,defaultPinned,themes,generatedAt:source.generatedAt,
    inputs:{voiceMemo:{available:false,availability:'soon'}},
    availabilitySource:view?'registry_route_health_owner_gates_surface_view':'registry_route_health_owner_gates_reachability_unknown',
    ...(view?{surface:APP_SURFACE}:{})};
  if(Buffer.byteLength(JSON.stringify(value))>MAX_BYTES)throw fail();
  return value;
}

async function readSurfaceView():Promise<SurfaceView>{
  try{
    const raw=await readFile(path.join(stateDir(),'capability-views',APP_SURFACE+'.json'),'utf8');
    if(Buffer.byteLength(raw)>4*MAX_BYTES)return null;
    return parseSurfaceView(JSON.parse(raw));
  }catch{return null;}
}

async function ownerGates():Promise<GateEvidence>{
  try{const {payments}=await import('./payments');return ownerGateEvidence(payments.capabilities());}
  catch{return {};}
}

async function generate(locale:'fr'|'en',abort?:AbortSignal):Promise<any>{
  const root=controlPaths().playbooks;
  const healthPath=path.join(stateDir(),'skill-intelligence','route-health.json');
  const [gates,view]=await Promise.all([ownerGates(),readSurfaceView()]);
  const source=await new Promise<any>((resolve,reject)=>execFile('python3',['-c',HS1_SCRIPT,locale,healthPath,JSON.stringify(gates)],{cwd:root,timeout:6000,maxBuffer:MAX_BYTES,signal:abort},(error,stdout)=>{
    if(error){reject(fail());return;}try{resolve(JSON.parse(stdout));}catch{reject(fail());}
  }));
  if(source?.locale!==locale)throw fail();
  return catalogProjection(source,view);
}

const lastGood=new Map<string,{value:any;at:number}>();

/** Shared single flight and 15 s cache in the existing Control pool. */
function refresh(locale:'fr'|'en'):Promise<any>{
  const key='catalog:'+JSON.stringify([controlPaths().playbooks,stateDir(),locale]);
  return readControlProjection(key,abort=>generate(locale,abort)).then(value=>{lastGood.set(key,{value,at:Date.now()});return value;});
}

/**
 * Warm reads are served from memory (budget 300 ms p95; one HS1 generation costs ≈ 360 ms on the S24).
 * A projection older than the pool TTL is served while the pool recomputes it, up to 10 minutes; past that,
 * or on the very first read, the caller waits for the shared generation (bounded by the 6 s child timeout).
 */
export async function readCatalogResponse(locale:'fr'|'en'):Promise<any>{
  const key='catalog:'+JSON.stringify([controlPaths().playbooks,stateDir(),locale]);
  const hit=lastGood.get(key);
  if(hit&&Date.now()-hit.at<STALE_MAX_MS){
    const pending=refresh(locale).catch(()=>undefined);
    const fresh=await Promise.race([pending,new Promise(r=>setTimeout(()=>r(undefined),5))]);
    return fresh??lastGood.get(key)?.value??hit.value;
  }
  return refresh(locale);
}
export function catalogETag(value:any):string{return '"'+createHash('sha256').update(JSON.stringify(value)).digest('hex')+'"';}
/** Test hook: forget served projections (no persistent state exists). */
export function resetCatalogCache(){lastGood.clear();}
