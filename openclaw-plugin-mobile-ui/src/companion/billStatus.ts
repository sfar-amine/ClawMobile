import {lstat,readdir,readFile} from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * Bills status (STEG, SONEDE, Topnet) for GET /v1/catalog — dernier état connu, dérivé des propriétaires existants :
 *  1. reçus du pont MCP ~/.openclaw/remote-bridge/requests/<requestId>.json (capture S24 core #176,
 *     hs2/qualified-receipts-owner.json) : result.capability = billing.utility.fast_path, execution.state = completed,
 *     execution.result (schema 2) → providers[] {provider, status, coverage_complete, has_pending, pending_count,
 *     total_pending, currency, items[].due_date, checked_at} ;
 *  2. paymentRequests confirmés du registre runs.json (« payée après paiement »).
 * Lecture seule : aucun appel fournisseur, aucun réseau, aucune écriture. Le seul état est un mémo borné en mémoire
 * (reçus terminaux déjà lus), reconstruit au redémarrage. Contrat : docs/work/samantha-runtime/contracts/
 * run-payment-presentation-and-bill-status-20261011.md.
 */
export const BILL_PROVIDERS=['steg','sonede','topnet'] as const;
export type BillProvider=typeof BILL_PROVIDERS[number];
export const BILLING_CAPABILITY='billing.utility.fast_path';
export type BillObservation={provider:BillProvider;state:'unpaid'|'paid'|'unknown';amountMinor?:number;dueDate?:string;checkedAt:string;reasonCode?:string};
export type BillStatus={provider:BillProvider;state:'unpaid'|'paid'|'unknown';amountMinor?:number;decimals:3;currency:'TND';dueDate?:string;
  checkedAt:string;source:'bridge_receipt'|'payment_request';reasonCode?:string;
  /** App contract (HomeCatalog.kt CatalogStatus): status line text, tone and the server time it was checked. */
  text:string;tone:'alert'|'info';at:string};

const ISO=/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:?[0-9]{2})$/;
const CODE=/^[a-z][a-z0-9_.-]{0,79}$/;
const NAME=/^[A-Za-z0-9._:-]{1,128}\.json$/;
const obj=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const isProvider=(v:unknown):v is BillProvider=>typeof v==='string'&&(BILL_PROVIDERS as readonly string[]).includes(v);

/** ISO instant normalised to UTC seconds, or undefined (never guessed). */
export function isoInstant(v:unknown):string|undefined{
  if(typeof v==='number'&&Number.isSafeInteger(v)&&v>0)return new Date(v).toISOString().replace(/\.\d{3}Z$/,'Z');
  if(typeof v!=='string'||!ISO.test(v))return undefined;
  const t=Date.parse(v);return Number.isFinite(t)?new Date(t).toISOString().replace(/\.\d{3}Z$/,'Z'):undefined;
}
/** Millimes from "84.300" / 84.3 (TND, 3 decimals); undefined when not an exact non-negative amount. */
export function millimes(v:unknown):number|undefined{
  const s=typeof v==='number'&&Number.isFinite(v)&&v>=0?v.toFixed(3):typeof v==='string'?v.trim():'';
  const m=/^(\d{1,7})(?:\.(\d{1,3}))?$/.exec(s);if(!m)return undefined;
  return Number(m[1])*1000+Number((m[2]||'').padEnd(3,'0'));
}
/** Provider due dates arrive as "15/10/2026", "15-10-2026" or ISO; anything else is dropped. */
export function dueDate(v:unknown):string|undefined{
  if(typeof v!=='string')return undefined;const s=v.trim();
  let y:string,mo:string,d:string;let m=/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s);
  if(m)[y,mo,d]=[m[1],m[2],m[3]];else if((m=/^(\d{2})[/.-](\d{2})[/.-](\d{4})$/.exec(s)))[y,mo,d]=[m[3],m[2],m[1]];else return undefined;
  const t=Date.UTC(+y,+mo-1,+d);const date=new Date(t);
  return date.getUTCFullYear()===+y&&date.getUTCMonth()===+mo-1&&date.getUTCDate()===+d?`${y}-${mo}-${d}`:undefined;
}

/** Observations carried by ONE bridge receipt; [] when it is not a completed billing read. */
export function billObservationsFromReceipt(receipt:unknown):BillObservation[]{
  if(!obj(receipt)||receipt.state!=='completed'||!obj(receipt.result))return [];
  const r=receipt.result,execution=r.execution;
  const capability=r.capability??(obj(r.selected)?r.selected.capability:undefined);
  if(r.success!==true||capability!==BILLING_CAPABILITY||!obj(execution)||execution.state!=='completed'||execution.exit_code!==0)return [];
  const value=execution.result;
  if(!obj(value)||value.schema_version!==2||!Array.isArray(value.providers)||value.providers.length>8)return [];
  const fallbackAt=isoInstant(value.checked_at)??isoInstant(receipt.completedAt);
  const out:BillObservation[]=[];const seen=new Set<string>();
  for(const row of value.providers){
    if(!obj(row)||!isProvider(row.provider)||seen.has(row.provider))continue;seen.add(row.provider);
    const checkedAt=isoInstant(row.checked_at)??fallbackAt;if(!checkedAt)continue;
    const currency=row.currency??value.currency??'TND';
    const complete=row.status==='ok'&&row.coverage_complete===true&&currency==='TND';
    if(complete&&row.has_pending===false){out.push({provider:row.provider,state:'paid',amountMinor:0,checkedAt});continue;}
    if(row.status==='ok'&&row.has_pending===true&&currency==='TND'){
      // A known positive survives a partial coverage; its amount only when the provider total is complete.
      const amount=complete?millimes(row.total_pending):undefined;
      const dues=(Array.isArray(row.items)?row.items.slice(0,200):[]).map((i:any)=>dueDate(i?.due_date)).filter(Boolean).sort() as string[];
      out.push({provider:row.provider,state:'unpaid',...(amount!==undefined&&amount>0?{amountMinor:amount}:{}),...(dues[0]?{dueDate:dues[0]}:{}),checkedAt});continue;
    }
    const reason=[row.reason_code,row.status].find(v=>typeof v==='string'&&CODE.test(v)&&v!=='ok');
    out.push({provider:row.provider,state:'unknown',checkedAt,reasonCode:reason??'coverage_incomplete'});
  }
  return out;
}

const fmt=(m:number)=>`${Math.floor(m/1000)}.${String(m%1000).padStart(3,'0')}`;
function line(s:Omit<BillStatus,'text'|'tone'|'at'>,locale:'fr'|'en'):{text:string;tone:'alert'|'info'}{
  const fr=locale==='fr',money=s.amountMinor?` · ${fmt(s.amountMinor)} ${fr?'DT':'TND'}`:'';
  if(s.state==='unpaid')return {text:(fr?'Impayée':'Unpaid')+money,tone:'alert'};
  if(s.state==='paid')return {text:s.source==='payment_request'?(fr?'Payée':'Paid')+money:fr?'Aucun impayé':'Nothing due',tone:'info'};
  return {text:fr?'État non vérifié':'Status not verified',tone:'info'};
}

/**
 * Latest known status per provider. A confirmed payment newer than the last check marks the bill paid only when it
 * matches the unpaid amount (or no complete check exists); otherwise the status becomes unknown until the next check.
 */
export function billStatuses(observations:BillObservation[],payments:unknown[],locale:'fr'|'en'):Partial<Record<BillProvider,BillStatus>>{
  const latest=new Map<BillProvider,BillObservation>();
  for(const o of observations)if(isProvider(o?.provider)){const prev=latest.get(o.provider);if(!prev||Date.parse(o.checkedAt)>=Date.parse(prev.checkedAt))latest.set(o.provider,o);}
  const paid=new Map<BillProvider,{at:string;amountMinor:number}>();
  for(const p of Array.isArray(payments)?payments:[]){
    if(!obj(p)||p.state!=='confirmed'||!obj(p.draft)||p.draft.mode!=='live'||!isProvider(p.draft.adapterId)||!obj(p.quote)||p.quote.currency!=='TND'||p.quote.decimals!==3||!Number.isSafeInteger(p.quote.amountMinor))continue;
    const at=isoInstant(p.endedAt??p.updatedAt);if(!at)continue;
    const prev=paid.get(p.draft.adapterId);if(!prev||Date.parse(at)>Date.parse(prev.at))paid.set(p.draft.adapterId,{at,amountMinor:p.quote.amountMinor});
  }
  const out:Partial<Record<BillProvider,BillStatus>>={};
  for(const provider of BILL_PROVIDERS){
    const o=latest.get(provider),pay=paid.get(provider);
    let base:Omit<BillStatus,'text'|'tone'|'at'>|undefined;
    if(pay&&(!o||Date.parse(pay.at)>Date.parse(o.checkedAt))){
      const matches=!o||o.state!=='unpaid'||o.amountMinor===undefined||o.amountMinor===pay.amountMinor;
      base=matches?{provider,state:'paid',amountMinor:pay.amountMinor,decimals:3,currency:'TND',checkedAt:pay.at,source:'payment_request'}
        :{provider,state:'unknown',decimals:3,currency:'TND',checkedAt:pay.at,source:'payment_request',reasonCode:'payment_after_check'};
    }else if(o){
      base={provider,state:o.state,...(o.amountMinor!==undefined?{amountMinor:o.amountMinor}:{}),decimals:3,currency:'TND',
        ...(o.dueDate?{dueDate:o.dueDate}:{}),checkedAt:o.checkedAt,source:'bridge_receipt',...(o.reasonCode?{reasonCode:o.reasonCode}:{})};
    }
    if(base)out[provider]={...base,...line(base,locale),at:base.checkedAt};
  }
  return out;
}

// ---- Bounded read of the bridge receipts (never on the request path: runs inside the catalog generation). ----
const MAX_RECEIPT_BYTES=1024*1024;
const MAX_NAMES=120_000;
const SCAN_BUDGET_MS=1500;
const STAT_BATCH=64;
const REUSE_MS=5000;
/** name → observations of a TERMINAL receipt (never changes again); non-terminal receipts are re-read next scan. */
const memo=new Map<string,BillObservation[]|null>();
let inFlight:Promise<BillObservation[]>|undefined;let last:{at:number;dir:string;value:BillObservation[]}|undefined;
const TERMINAL=new Set(['completed','failed','abandoned']);

export function bridgeRequestDir(){return path.join(process.env.OPENCLAW_STATE_DIR||path.join(os.homedir(),'.openclaw'),'remote-bridge','requests');}

/** One bounded pass (no reuse window); exported for the budget test. */
export async function scanBillObservations(dir:string,budgetMs=SCAN_BUDGET_MS):Promise<BillObservation[]>{
  const started=Date.now();const left=()=>budgetMs-(Date.now()-started);
  let names:string[];
  try{names=(await readdir(dir)).filter(n=>NAME.test(n)).slice(0,MAX_NAMES);}catch{names=[];}
  const present=new Set(names);for(const k of Array.from(memo.keys()))if(!present.has(k))memo.delete(k);
  const unseen=names.filter(n=>!memo.has(n));const stats:{name:string;mtimeMs:number;size:number}[]=[];
  for(let i=0;i<unseen.length&&left()>0;i+=STAT_BATCH){
    const batch=await Promise.all(unseen.slice(i,i+STAT_BATCH).map(name=>lstat(path.join(dir,name)).then(s=>s.isFile()&&s.nlink===1?{name,mtimeMs:s.mtimeMs,size:s.size}:null,()=>null)));
    for(const [k,row] of batch.entries()){if(row)stats.push(row);else memo.set(unseen[i+k],null);}
  }
  stats.sort((a,b)=>b.mtimeMs-a.mtimeMs);
  for(const s of stats){
    if(left()<=0)break; // the rest is read by the next generation, newest first
    if(s.size>MAX_RECEIPT_BYTES){memo.set(s.name,null);continue;}
    try{
      const row=JSON.parse(await readFile(path.join(dir,s.name),'utf8'));
      if(!obj(row)||row.requestId+'.json'!==s.name){memo.set(s.name,null);continue;}
      if(!TERMINAL.has(row.state))continue;
      const found=billObservationsFromReceipt(row);memo.set(s.name,found.length?found:null);
    }catch{memo.set(s.name,null);}
  }
  const out:BillObservation[]=[];for(const v of memo.values())if(v)out.push(...v);
  return out;
}

/** Shared single flight, reused for 5 s across locales; bounded by SCAN_BUDGET_MS. */
export function readBillObservations(dir=bridgeRequestDir(),budgetMs=SCAN_BUDGET_MS):Promise<BillObservation[]>{
  if(last&&last.dir===dir&&Date.now()-last.at<REUSE_MS)return Promise.resolve(last.value);
  if(!inFlight)inFlight=scanBillObservations(dir,budgetMs).then(value=>{last={at:Date.now(),dir,value};return value;}).finally(()=>{inFlight=undefined;});
  return inFlight;
}
/** Test hook: forget the in-memory memo (no persistent state exists). */
export function resetBillStatusMemo(){memo.clear();last=undefined;}
