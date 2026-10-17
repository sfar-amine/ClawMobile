import {lstat,readdir,readFile} from 'fs/promises';
import {createHash} from 'crypto';
import os from 'os';
import path from 'path';

/** HS2 consumes the qualified projection emitted inside the existing Capability Graph receipt (playbooks #93). */
export const BILL_PROVIDERS=['steg','sonede','topnet'] as const;
export type BillProvider=typeof BILL_PROVIDERS[number];
export const BILLING_CAPABILITY='billing.utility.fast_path';
export const ORANGE_CAPABILITY='telecom.orange.consultation';
export const GENERAL_STATUS_TTL_S=24*60*60;
export const BALANCE_TTL_S=60*60;
const MAX_CLOCK_SKEW_MS=5*60_000;

export type CatalogStatus={state:'unpaid'|'clear'|'available';checkedAt:string;expiresAt:string;observedDisplay:string;
  source:'qualified_receipt';text:string;tone:'alert'|'info';at:string;count?:number};
export type QualifiedStatuses={bills:Partial<Record<BillProvider,CatalogStatus>>;orange?:CatalogStatus};
export type QualifiedReceipt={version:1;capability:string;kind:'general_status'|'balance';scope:string;observedAt:string;
  observedDisplay:string;expiresAt:string;ttlSeconds:number;successVerified:true;completeness:'complete';
  sourceReceiptRevision:string;items:Record<string,any>[]};

const ISO=/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const NAME=/^[A-Za-z0-9._:-]{1,128}\.json$/;
const SCOPE=/^[A-Za-z0-9_.:-]{1,40}$/;
const obj=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const isProvider=(v:unknown):v is BillProvider=>typeof v==='string'&&(BILL_PROVIDERS as readonly string[]).includes(v);
const instant=(v:unknown):number|undefined=>typeof v==='string'&&ISO.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):undefined;
const display=(ms:number)=>{const d=new Date(ms),p=(n:number)=>String(n).padStart(2,'0');return `${p(d.getUTCDate())}/${p(d.getUTCMonth()+1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;};

/** Python json.dumps(sort_keys=True,separators=(',',':'),ensure_ascii=False) parity for playbooks' revision. */
function canonical(value:any):string{
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(obj(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  throw new Error('invalid_qualified_receipt');
}
function revision(value:Record<string,any>):string{return createHash('sha256').update(canonical(value)).digest('hex');}

/** Validate again on every read. No legacy payload, payment row, cache time or completedAt can create freshness. */
export function readQualifiedReceipt(value:unknown,nowMs=Date.now()):QualifiedReceipt|undefined{
  if(!obj(value)||value.version!==1||![BILLING_CAPABILITY,ORANGE_CAPABILITY].includes(value.capability)||
    !['general_status','balance'].includes(value.kind)||typeof value.scope!=='string'||!SCOPE.test(value.scope)||
    value.successVerified!==true||value.completeness!=='complete'||!Array.isArray(value.items)||
    !value.items.length||value.items.length>32||typeof value.sourceReceiptRevision!=='string'||
    !/^[0-9a-f]{64}$/.test(value.sourceReceiptRevision)||!Number.isFinite(nowMs))return undefined;
  const observed=instant(value.observedAt),expires=instant(value.expiresAt);
  const ttl=value.kind==='balance'?BALANCE_TTL_S:GENERAL_STATUS_TTL_S;
  if(observed===undefined||expires===undefined||value.ttlSeconds!==ttl||expires-observed!==ttl*1000||
    observed>nowMs+MAX_CLOCK_SKEW_MS||nowMs>=expires||value.observedDisplay!==display(observed))return undefined;
  if(value.capability===BILLING_CAPABILITY&&(value.kind!=='general_status'||value.scope!=='billing'))return undefined;
  if(value.capability===ORANGE_CAPABILITY&&(value.kind!=='balance'||value.scope!=='orange'))return undefined;
  const seen=new Set<string>();
  for(const item of value.items){
    if(!obj(item)||item.observedAt!==value.observedAt||item.observedDisplay!==value.observedDisplay||
      typeof item.scope!=='string'||!SCOPE.test(item.scope))return undefined;
    if(value.kind==='general_status'){
      if(seen.has(item.scope)||!isProvider(item.scope)||!['unpaid','clear'].includes(item.state)||
        (item.count!==undefined&&(!Number.isInteger(item.count)||item.count<0||item.count>10_000))||
        (item.state==='clear'&&item.count!==undefined&&item.count!==0))return undefined;
      seen.add(item.scope);
    }else if(typeof item.value!=='string'||!item.value||item.value.length>80||typeof item.unit!=='string'||
      !item.unit||item.unit.length>24||/[\u0000-\u001f]/.test(item.value+item.unit))return undefined;
  }
  const unsigned={...value};delete unsigned.sourceReceiptRevision;
  if(revision(unsigned)!==value.sourceReceiptRevision)return undefined;
  return value as QualifiedReceipt;
}

/** Outer bridge receipt and inner owner result must agree with the qualified projection. */
export function qualifiedReceiptFromBridge(receipt:unknown,nowMs=Date.now()):QualifiedReceipt|undefined{
  if(!obj(receipt)||receipt.state!=='completed'||!obj(receipt.result))return undefined;
  const result=receipt.result,execution=result.execution,qualified=readQualifiedReceipt(result.qualified_receipt,nowMs);
  const capability=result.capability??(obj(result.selected)?result.selected.capability:undefined);
  if(result.success!==true||!obj(execution)||execution.state!=='completed'||execution.exit_code!==0||
    !qualified||capability!==qualified.capability)return undefined;
  return qualified;
}

function suffix(locale:'fr'|'en',receipt:QualifiedReceipt){return `${locale==='fr'?'Vérifié':'Checked'} ${receipt.observedDisplay}`;}
/** Display projection: the visible text itself contains date + time; `at` remains for native formatting/accessibility. */
export function qualifiedStatuses(receipts:QualifiedReceipt[],locale:'fr'|'en'):QualifiedStatuses{
  const latest=new Map<string,QualifiedReceipt>();
  for(const receipt of receipts){const previous=latest.get(receipt.capability);if(!previous||receipt.observedAt>=previous.observedAt)latest.set(receipt.capability,receipt);}
  const out:QualifiedStatuses={bills:{}};
  const billing=latest.get(BILLING_CAPABILITY);
  if(billing)for(const item of billing.items){
    const state=item.state as 'unpaid'|'clear';const count=Number.isInteger(item.count)?item.count:undefined;
    const label=state==='unpaid'?(locale==='fr'?'Impayée':'Unpaid'):(locale==='fr'?'Aucun impayé':'Nothing due');
    out.bills[item.scope as BillProvider]={state,checkedAt:billing.observedAt,expiresAt:billing.expiresAt,
      observedDisplay:billing.observedDisplay,source:'qualified_receipt',text:`${label} · ${suffix(locale,billing)}`,
      tone:state==='unpaid'?'alert':'info',at:billing.observedAt,...(count!==undefined?{count}:{})};
  }
  const orange=latest.get(ORANGE_CAPABILITY);
  if(orange){
    const values=orange.items.map(item=>`${item.value} ${item.unit}`).join(' · ');
    out.orange={state:'available',checkedAt:orange.observedAt,expiresAt:orange.expiresAt,
      observedDisplay:orange.observedDisplay,source:'qualified_receipt',text:`${values} · ${suffix(locale,orange)}`,
      tone:'info',at:orange.observedAt};
  }
  return out;
}

// ---- Bounded read of existing bridge receipts. The memo stores envelopes, never a freshness verdict. ----
const MAX_RECEIPT_BYTES=1024*1024;
const MAX_NAMES=120_000;
const SCAN_BUDGET_MS=1500;
const STAT_BATCH=64;
const REUSE_MS=5000;
const memo=new Map<string,unknown|null>();
/** lstat results kept across passes: without it, every pass re-stats every unread name before reading any, and on a
 * large directory the stat phase alone eats the whole budget, so no pass ever progresses (CI 17/10: 50 000 receipts,
 * 60 passes, zero read). */
const statMemo=new Map<string,{mtimeMs:number;size:number}>();
let inFlight:Promise<QualifiedReceipt[]>|undefined;
let last:{at:number;dir:string;value:(QualifiedReceipt|null)[]}|undefined;
const TERMINAL=new Set(['completed','failed','abandoned']);

export function bridgeRequestDir(){return path.join(process.env.OPENCLAW_STATE_DIR||path.join(os.homedir(),'.openclaw'),'remote-bridge','requests');}

export async function scanQualifiedReceipts(dir:string,budgetMs=SCAN_BUDGET_MS,nowMs=Date.now()):Promise<QualifiedReceipt[]>{
  const started=Date.now(),left=()=>budgetMs-(Date.now()-started);let names:string[];
  try{names=(await readdir(dir)).filter(n=>NAME.test(n)).slice(0,MAX_NAMES);}catch{names=[];}
  const present=new Set(names);
  for(const k of Array.from(memo.keys()))if(!present.has(k))memo.delete(k);
  for(const k of Array.from(statMemo.keys()))if(!present.has(k)||memo.has(k))statMemo.delete(k);
  const unseen=names.filter(n=>!memo.has(n));const toStat=unseen.filter(n=>!statMemo.has(n));
  for(let i=0;i<toStat.length&&left()>0;i+=STAT_BATCH){
    const batch=await Promise.all(toStat.slice(i,i+STAT_BATCH).map(name=>lstat(path.join(dir,name)).then(s=>s.isFile()&&s.nlink===1?{mtimeMs:s.mtimeMs,size:s.size}:null,()=>null)));
    for(const [k,row] of batch.entries()){const name=toStat[i+k];if(row)statMemo.set(name,row);else memo.set(name,null);}
  }
  const stats:{name:string;mtimeMs:number;size:number}[]=[];
  for(const name of unseen){const row=statMemo.get(name);if(row)stats.push({name,...row});}
  stats.sort((a,b)=>b.mtimeMs-a.mtimeMs);
  for(const s of stats){
    if(left()<=0)break;
    if(s.size>MAX_RECEIPT_BYTES){memo.set(s.name,null);continue;}
    try{
      const row=JSON.parse(await readFile(path.join(dir,s.name),'utf8'));
      if(!obj(row)||row.requestId+'.json'!==s.name){memo.set(s.name,null);continue;}
      if(!TERMINAL.has(row.state))continue;
      memo.set(s.name,row);
    }catch{memo.set(s.name,null);}
  }
  const out:QualifiedReceipt[]=[];
  for(const raw of memo.values()){const value=qualifiedReceiptFromBridge(raw,nowMs);if(value)out.push(value);}
  return out;
}

export function readQualifiedReceipts(dir=bridgeRequestDir(),budgetMs=SCAN_BUDGET_MS,nowMs=Date.now()):Promise<QualifiedReceipt[]>{
  const project=(values:(QualifiedReceipt|null)[])=>values.map(v=>readQualifiedReceipt(v,nowMs)).filter((v):v is QualifiedReceipt=>!!v);
  if(last&&last.dir===dir&&Date.now()-last.at<REUSE_MS)return Promise.resolve(project(last.value));
  if(!inFlight)inFlight=scanQualifiedReceipts(dir,budgetMs,nowMs).then(value=>{last={at:Date.now(),dir,value};return value;}).finally(()=>{inFlight=undefined;});
  return inFlight;
}
export function resetQualifiedReceiptMemo(){memo.clear();statMemo.clear();last=undefined;}
