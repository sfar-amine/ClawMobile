// Bills status in GET /v1/catalog (STEG, SONEDE, Topnet) from existing owners only: bridge receipts
// (~/.openclaw/remote-bridge/requests/*.json) and confirmed paymentRequests. Inputs: real S24 capture of the billing
// bridge receipt (core #176, fixtures/s24-2026-10-11/hs2/qualified-receipts-owner.json; ages → instants, amounts
// masked by the capture), real HS1 projection (fixtures/s24-2026-10-11d) and a 50 000-receipt directory (AGENTS volume;
// 7 138 receipts on the S24 the 10/10, f6 capture). No supplier call, no network, no write.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process');
const NOW=Date.now();
const hs2=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/hs2/qualified-receipts-owner.json'),'utf8'));
const fixtures=path.join(__dirname,'../fixtures/s24-2026-10-11d');
const sources=JSON.parse(fs.readFileSync(path.join(fixtures,'hs2-catalog-sources.json'),'utf8'));
const hs1=Object.fromEntries(['fr','en'].map(l=>[l,JSON.parse(fs.readFileSync(path.join(fixtures,`hs1-catalog-from-s24-sources.${l}.json`),'utf8'))]));
const state=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-bills-'));process.env.OPENCLAW_STATE_DIR=state;
const iso=ageS=>new Date(NOW-ageS*1000).toISOString().replace(/\.\d{3}Z$/,'Z');
const at=v=>v&&typeof v==='object'&&'ageS' in v?iso(v.ageS):v;

// Real billing receipt rebuilt in its on-disk shape (the capture flattens "execution.result" paths).
const ex=hs2.bridgeExamples['billing.utility.fast_path'][0];
function billingReceipt(requestId,overrides={}){
  const result={...ex.result['execution.result'],checked_at:at(ex.result['execution.result'].checked_at),currency:'TND',
    providers:ex.result['execution.result.providers'].map(p=>({...p,checked_at:at(p.checked_at),currency:'TND',...(overrides[p.provider]||{})}))};
  return {requestId,method:ex.method,paramsHash:'h',state:ex.state,instanceId:'i',receivedAt:NOW-ex.receivedAgeS*1000,completedAt:NOW-ex.completedAgeS*1000,
    mutationRisk:ex.mutationRisk,result:{success:ex.result.success,capability:ex.result.capability,surface:ex.result.surface,caller:ex.result.caller,
      selected:ex.result.selected,execution:{...ex.result.execution,result}}};
}
const bills=require('../dist/companion/billStatus');
// 1. Pure projection of the real receipt: STEG has_pending=true (amount masked), SONEDE and Topnet nothing pending.
const obs=bills.billObservationsFromReceipt(billingReceipt('r1'));
assert.deepEqual(obs.map(o=>o.provider+':'+o.state),['steg:unpaid','sonede:paid','topnet:paid']);
assert.equal(obs[0].amountMinor,undefined);assert.equal(obs[0].checkedAt,iso(428445));
for(const other of Object.keys(hs2.bridgeExamples).filter(k=>k!=='billing.utility.fast_path'))
  assert.deepEqual(bills.billObservationsFromReceipt({...billingReceipt('x'),result:{...billingReceipt('x').result,capability:other}}),[]);
assert.deepEqual(bills.billObservationsFromReceipt({...billingReceipt('x'),state:'running'}),[]);
// Owner fields that the capture masks: total_pending and items[].due_date (billing-model.mjs / billing-parsers.mjs).
const priced=bills.billObservationsFromReceipt(billingReceipt('r2',{steg:{total_pending:'84.300',items:[{due_date:'15/11/2026'},{due_date:'31/10/2026'}]}}))[0];
assert.deepEqual([priced.amountMinor,priced.dueDate],[84300,'2026-10-31']);
const partial=bills.billObservationsFromReceipt(billingReceipt('r3',{topnet:{status:'auth_required',coverage_complete:false,has_pending:null,reason_code:null}}))[2];
assert.deepEqual([partial.state,partial.reasonCode],['unknown','auth_required']);
let s=bills.billStatuses([priced],[],'fr').steg;
assert.deepEqual({state:s.state,amountMinor:s.amountMinor,currency:s.currency,dueDate:s.dueDate,source:s.source,text:s.text,tone:s.tone,at:s.at===s.checkedAt},
  {state:'unpaid',amountMinor:84300,currency:'TND',dueDate:'2026-10-31',source:'bridge_receipt',text:'Impayée · 84.300 DT',tone:'alert',at:true});
// Paid after payment: a confirmed live payment newer than the check and matching the amount.
const pay=(adapterId,amountMinor,endedAt)=>({state:'confirmed',reasonCode:'gateway_and_provider_confirmed',draft:{adapterId,mode:'live'},quote:{currency:'TND',decimals:3,amountMinor},endedAt,updatedAt:endedAt});
s=bills.billStatuses([priced],[pay('steg',84300,NOW-1000)],'en').steg;assert.deepEqual([s.state,s.source,s.text,s.amountMinor],['paid','payment_request','Paid · 84.300 TND',84300]);
s=bills.billStatuses([priced],[pay('steg',1000,NOW-1000)],'fr').steg;assert.deepEqual([s.state,s.reasonCode],['unknown','payment_after_check']);
s=bills.billStatuses([priced],[pay('steg',84300,Date.parse(priced.checkedAt)-1000)],'fr').steg;assert.equal(s.state,'unpaid'); // older payment
s=bills.billStatuses([priced],[{...pay('steg',84300,NOW),state:'effect_unknown'},{...pay('steg',84300,NOW),draft:{adapterId:'steg',mode:'demo'}}],'fr').steg;assert.equal(s.state,'unpaid');

// 2. Catalog projection carries the app contract (HomeCatalog.kt: group.status {text,tone,source,at}, theme.badge).
const {catalogProjection,parseSurfaceView,resetCatalogCache}=require('../dist/companion/catalog');
const view=parseSurfaceView(sources.view);
const statusesFr=bills.billStatuses(obs,[],'fr');
const v=catalogProjection(hs1.fr,view,statusesFr);
const billsTheme=v.themes.find(t=>t.id==='bills');const g=id=>billsTheme.groups.find(x=>x.id===id);
assert.deepEqual(['steg','sonede','topnet'].map(id=>g(id).status.text),['Impayée','Aucun impayé','Aucun impayé']);
for(const id of ['steg','sonede','topnet']){const st=g(id).status;assert.equal(st.source,'bridge_receipt');assert.equal(st.at,iso(id==='steg'?428445:id==='sonede'?428447:428446));assert.ok(['alert','info'].includes(st.tone));
  assert.deepEqual(g(id).actions.find(a=>a.capability==='billing.utility.fast_path').status,st);assert.equal(g(id).actions.find(a=>a.kind==='pay').status,undefined);}
assert.deepEqual(billsTheme.badge,{tone:'alert',count:1,source:'bridge_receipt',at:iso(428445),text:'1 impayée'});
assert.ok(v.themes.filter(t=>t.id!=='bills').every(t=>!t.badge&&t.groups.every(x=>!x.status)));
assert.deepEqual(catalogProjection(hs1.fr,view),catalogProjection(hs1.fr,view,{})); // no source: no status line, nothing invented
assert.ok(!JSON.stringify(v).includes('"status":"ok"'));

// 3. Route: 50 000 receipts, the only billing receipt is the oldest file. Warm reads stay within 300 ms while the
// bounded scan (1.5 s per generation, newest first, memo of terminal receipts) catches up in the background.
const dir=path.join(state,'remote-bridge','requests');fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'req-billing.json'),JSON.stringify(billingReceipt('req-billing')));fs.utimesSync(path.join(dir,'req-billing.json'),new Date(NOW-500000e3),new Date(NOW-500000e3));
const filler=JSON.stringify({requestId:'X',method:'exec_wait',paramsHash:'h',state:'completed',instanceId:'i',receivedAt:NOW,completedAt:NOW,mutationRisk:'read',result:{output:'x'.repeat(200)}});
for(let i=0;i<50000;i++)fs.writeFileSync(path.join(dir,`req-${i}.json`),filler.replace('"X"',`"req-${i}"`));
fs.writeFileSync(path.join(dir,'req-running.json'),JSON.stringify({requestId:'req-running',method:'mcp_capability_execute_owner',state:'running',mutationRisk:'unknown'}));
fs.mkdirSync(path.join(state,'capability-views'));fs.mkdirSync(path.join(state,'skill-intelligence'));
fs.writeFileSync(path.join(state,'capability-views/samantha_android.json'),JSON.stringify(sources.view));
process.env.SAMANTHA_CONTROL_PLAYBOOKS='/pinned-playbooks-test';
let forbidden=0;
cp.execFile=(command,args,options,callback)=>{
  if(command!=='python3'||!String(args[1]).includes('from reporting.control_capability import catalog')){forbidden++;callback(Error('forbidden child'),'');return {};}
  const timer=setTimeout(()=>callback(null,JSON.stringify(hs1[args[2]])),360);options.signal?.addEventListener('abort',()=>{clearTimeout(timer);callback(Error('cancelled'),'')},{once:true});return {};
};
require('../dist/companion/openclawAgentClient').callOpenClawGateway=()=>{forbidden++;throw Error('live gateway forbidden');};
const paymentsModule=require('../dist/companion/payments');paymentsModule.payments.listPayables=()=>{forbidden++;throw Error('live payables forbidden');};
paymentsModule.payments.capabilities=()=>({schemaVersion:1,adapters:[]});
fs.mkdirSync(path.join(state,'clawmobile-companion'));
fs.writeFileSync(path.join(state,'clawmobile-companion/runs.json'),JSON.stringify({version:1,runs:[],archivedSessionIds:[],ownerConfirmations:[],runDeletions:[],
  paymentRequests:[pay('topnet',12000,NOW-60000)]}));
(async()=>{
  // Scan bound: each pass ≤ budget + one batch; the oldest billing receipt is reached after a few passes.
  bills.resetBillStatusMemo();let passes=0,found=[],slowest=0;
  while(!found.length&&passes<60){const t=performance.now();
    found=await bills.scanBillObservations(dir,1500);slowest=Math.max(slowest,performance.now()-t);passes++;}
  assert.equal(found.length,3,`billing receipt not reached after ${passes} passes`);assert.ok(slowest<2500,`scan pass ${slowest} ms`);
  const t1=performance.now();const again=await bills.scanBillObservations(dir,1500);const memoMs=performance.now()-t1;
  assert.equal(again.length,3);assert.ok(memoMs<1000,`memo pass ${memoMs} ms`);
  const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const get=(locale='fr')=>new Promise((resolve,reject)=>{const start=performance.now();http.get({host:'127.0.0.1',port:server.address().port,path:'/v1/catalog?locale='+locale},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw),ms:performance.now()-start}));}).on('error',reject);});
  try{
    resetCatalogCache();const cold=await get();assert.equal(cold.status,200);
    const topnet=cold.body.themes.find(t=>t.id==='bills').groups.find(x=>x.id==='topnet').status;
    assert.deepEqual([topnet.state,topnet.source,topnet.amountMinor,topnet.text],['paid','payment_request',12000,'Payée · 12.000 DT']);
    assert.equal(cold.body.themes.find(t=>t.id==='bills').groups.find(x=>x.id==='steg').status.state,'unpaid');
    const warm=[];for(let i=0;i<20;i++)warm.push((await get()).ms);
    const p95=warm.sort((a,b)=>a-b)[Math.ceil(warm.length*0.95)-1];assert.ok(p95<300,`warm p95 ${p95} ms`);
    const en=await get('en');assert.equal(en.body.themes.find(t=>t.id==='bills').groups.find(x=>x.id==='steg').status.text,'Unpaid');
    assert.equal(forbidden,0);
    console.log(JSON.stringify({suite:'catalog-bill-status',s24Receipt:true,receipts:50002,scanPasses:passes,slowestPassMs:Math.round(slowest),memoPassMs:Math.round(memoMs),coldMs:Math.round(cold.ms),warmP95Ms:Math.round(p95)}));
  }finally{await new Promise(r=>server.close(r));fs.rmSync(state,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1);});
