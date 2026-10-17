// HS2 catalogue statuses consume only playbooks #93 qualified_receipt envelopes inside existing bridge receipts.
// Source shapes come from cleaned S24 captures #176/#184; the envelope is the new cross-repo contract.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process'),crypto=require('node:crypto');
const NOW=Date.parse('2026-10-13T12:30:00Z');
const hs2=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/hs2/qualified-receipts-owner.json'),'utf8'));
const fixtures=path.join(__dirname,'../fixtures/s24-2026-10-11d');
const sources=JSON.parse(fs.readFileSync(path.join(fixtures,'hs2-catalog-sources.json'),'utf8'));
const hs1=Object.fromEntries(['fr','en'].map(l=>[l,JSON.parse(fs.readFileSync(path.join(fixtures,`hs1-catalog-from-s24-sources.${l}.json`),'utf8'))]));
const state=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-qualified-'));process.env.OPENCLAW_STATE_DIR=state;
const stable=v=>v===null||['boolean','string','number'].includes(typeof v)?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
const display=ms=>{const d=new Date(ms),p=n=>String(n).padStart(2,'0');return `${p(d.getUTCDate())}/${p(d.getUTCMonth()+1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;};
function seal({capability,kind,scope,observedAt,ttlSeconds,items}){
 const observed=Date.parse(observedAt),observedDisplay=display(observed);
 const value={version:1,capability,kind,scope,observedAt,observedDisplay,expiresAt:new Date(observed+ttlSeconds*1000).toISOString().replace('.000Z','Z'),ttlSeconds,successVerified:true,completeness:'complete',items:items.map(x=>({...x,observedAt,observedDisplay}))};
 value.sourceReceiptRevision=crypto.createHash('sha256').update(stable(value)).digest('hex');return value;
}
const ex=hs2.bridgeExamples['billing.utility.fast_path'][0];
const billing=seal({capability:'billing.utility.fast_path',kind:'general_status',scope:'billing',observedAt:'2026-10-13T12:00:00Z',ttlSeconds:86400,
 items:ex.result['execution.result.providers'].map(row=>({scope:row.provider,state:row.has_pending?'unpaid':'clear',...(Number.isInteger(row.pending_count)?{count:row.pending_count}:{})}))});
const orangeCapture=hs2.bridgeExamples['telecom.orange.consultation'][0].result['execution.result'];
const orange=seal({capability:'telecom.orange.consultation',kind:'balance',scope:'orange',observedAt:'2026-10-13T12:00:00Z',ttlSeconds:3600,
 items:orangeCapture.data.cards.filter(x=>x&&typeof x==='object').slice(0,3).map(x=>({scope:x.section||x.kind||'balance',value:x.value,unit:x.unit,...(Number.isInteger(x.days_remaining)?{daysRemaining:x.days_remaining}:{})}))});
// Keep the HTTP-route fixture fresh whenever this test is replayed. The fixed envelopes above remain
// deterministic for exact-boundary and mutation checks.
const LIVE_NOW=Date.now();
const liveBilling=seal({capability:'billing.utility.fast_path',kind:'general_status',scope:'billing',observedAt:new Date(LIVE_NOW-30*60*1000).toISOString().replace(/\.\d{3}Z$/,'Z'),ttlSeconds:86400,
 items:billing.items.map(({scope,state,count})=>({scope,state,...(Number.isInteger(count)?{count}:{})}))});
function receipt(requestId,qualified=billing,capability=qualified.capability){return {requestId,method:'mcp_capability_execute_owner',paramsHash:'h',state:'completed',instanceId:'i',receivedAt:NOW-1000,completedAt:NOW,
 mutationRisk:'read',result:{success:true,capability,selected:{capability},execution:{state:'completed',exit_code:0,result:{existingOwnerPayload:true}},qualified_receipt:qualified}};}
const q=require('../dist/companion/billStatus');
// 1. Exact reread boundary and outer receipt agreement. Legacy billStatus payloads are intentionally ignored.
assert.equal(q.readQualifiedReceipt(billing,NOW).capability,'billing.utility.fast_path');
assert.equal(q.readQualifiedReceipt(billing,Date.parse(billing.expiresAt)-1).capability,'billing.utility.fast_path');
assert.equal(q.readQualifiedReceipt(billing,Date.parse(billing.expiresAt)),undefined);
const changed=structuredClone(billing);changed.items[0].state='clear';assert.equal(q.readQualifiedReceipt(changed,NOW),undefined);
assert.equal(q.qualifiedReceiptFromBridge(receipt('r1'),NOW).sourceReceiptRevision,billing.sourceReceiptRevision);
assert.equal(q.qualifiedReceiptFromBridge({...receipt('r2'),result:{...receipt('r2').result,capability:'qa.test_campaign'}},NOW),undefined);
const legacy={requestId:'legacy',state:'completed',result:{success:true,capability:'billing.utility.fast_path',execution:{state:'completed',exit_code:0,result:ex.result['execution.result']}}};
assert.equal(q.qualifiedReceiptFromBridge(legacy,NOW),undefined);
// 2. Visible status and catalogue badge always carry date + time; Orange uses the one-hour receipt.
const statusesFr=q.qualifiedStatuses([billing,orange],'fr');
for(const status of [...Object.values(statusesFr.bills),statusesFr.orange]){assert.ok(status.text.includes('13/10/2026 12:00 UTC'));assert.equal(status.source,'qualified_receipt');}
const {catalogProjection,parseSurfaceView,revalidateCatalogStatuses,resetCatalogCache}=require('../dist/companion/catalog');
const view=parseSurfaceView(sources.view);const projected=catalogProjection(hs1.fr,view,statusesFr);
const billsTheme=projected.themes.find(t=>t.id==='bills'),lines=projected.themes.find(t=>t.id==='lines');
const steg=billsTheme.groups.find(g=>g.id==='steg').status,orangeStatus=lines.groups.find(g=>g.id==='orange').status;
assert.ok(steg.text.includes(steg.observedDisplay));assert.ok(orangeStatus.text.includes(orangeStatus.observedDisplay));
assert.ok(billsTheme.badge.text.includes(billsTheme.badge.observedDisplay));assert.equal(billsTheme.badge.source,'qualified_receipt');
const afterBalance=revalidateCatalogStatuses(projected,Date.parse(orange.expiresAt));
assert.equal(afterBalance.themes.find(t=>t.id==='lines').groups.find(g=>g.id==='orange').status,undefined);
assert.ok(afterBalance.themes.find(t=>t.id==='bills').groups.find(g=>g.id==='steg').status);
const afterAll=revalidateCatalogStatuses(projected,Date.parse(billing.expiresAt));
assert.equal(afterAll.themes.find(t=>t.id==='bills').groups.find(g=>g.id==='steg').status,undefined);assert.equal(afterAll.themes.find(t=>t.id==='bills').badge,undefined);
const injected=structuredClone(projected);injected.themes.find(t=>t.id==='bills').groups[0].status={source:'bridge_receipt',text:'legacy',at:'2026-10-01T00:00:00Z'};
assert.equal(revalidateCatalogStatuses(injected,NOW).themes.find(t=>t.id==='bills').groups[0].status,undefined);
// 3. 50k receipt volume remains bounded. The oldest qualified receipt is eventually found; warm route reads do no provider call.
const dir=path.join(state,'remote-bridge','requests');fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'req-qualified.json'),JSON.stringify(receipt('req-qualified',liveBilling)));fs.utimesSync(path.join(dir,'req-qualified.json'),new Date(LIVE_NOW-500000e3),new Date(LIVE_NOW-500000e3));
const filler=JSON.stringify({requestId:'X',method:'exec_wait',paramsHash:'h',state:'completed',instanceId:'i',receivedAt:LIVE_NOW,completedAt:LIVE_NOW,mutationRisk:'read',result:{output:'x'.repeat(200)}});
for(let i=0;i<50000;i++)fs.writeFileSync(path.join(dir,`req-${i}.json`),filler.replace('"X"',`"req-${i}"`));
fs.writeFileSync(path.join(dir,'req-legacy.json'),JSON.stringify({...legacy,requestId:'req-legacy'}));
fs.mkdirSync(path.join(state,'capability-views'));fs.mkdirSync(path.join(state,'skill-intelligence'));
fs.writeFileSync(path.join(state,'capability-views/samantha_android.json'),JSON.stringify(sources.view));process.env.SAMANTHA_CONTROL_PLAYBOOKS='/pinned-playbooks-test';
let forbidden=0;cp.execFile=(command,args,options,callback)=>{if(command!=='python3'||!String(args[1]).includes('from reporting.control_capability import catalog')){forbidden++;callback(Error('forbidden child'),'');return {};}
 const timer=setTimeout(()=>callback(null,JSON.stringify(hs1[args[2]])),20);options.signal?.addEventListener('abort',()=>{clearTimeout(timer);callback(Error('cancelled'),'')},{once:true});return {};};
require('../dist/companion/openclawAgentClient').callOpenClawGateway=()=>{forbidden++;throw Error('live gateway forbidden');};
(async()=>{
 q.resetQualifiedReceiptMemo();let passes=0,found=[],slowest=0;
 while(!found.length&&passes<60){const t=performance.now();found=await q.scanQualifiedReceipts(dir,1500,LIVE_NOW);slowest=Math.max(slowest,performance.now()-t);passes++;}
 assert.equal(found.length,1,`qualified receipt not reached after ${passes} passes`);assert.ok(slowest<2500,`scan pass ${slowest} ms`);
 resetCatalogCache();const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const get=()=>new Promise((resolve,reject)=>{const start=performance.now();http.get({host:'127.0.0.1',port:server.address().port,path:'/v1/catalog?locale=fr'},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw),ms:performance.now()-start}));}).on('error',reject);});
 try{const cold=await get();assert.equal(cold.status,200);const status=cold.body.themes.find(t=>t.id==='bills').groups.find(g=>g.id==='steg').status;assert.equal(status.source,'qualified_receipt');assert.ok(status.text.includes(liveBilling.observedDisplay));
  const warm=[];for(let i=0;i<20;i++)warm.push((await get()).ms);const p95=warm.sort((a,b)=>a-b)[Math.ceil(warm.length*.95)-1];assert.ok(p95<300,`warm p95 ${p95}`);assert.equal(forbidden,0);
  console.log(JSON.stringify({suite:'catalog-qualified-status',targeted: true,receipts:50002,passes,slowestPassMs:Math.round(slowest),warmP95Ms:Math.round(p95)}));
 }finally{await new Promise(r=>server.close(r));fs.rmSync(state,{recursive:true,force:true});}
})().catch(error=>{console.error(error);fs.rmSync(state,{recursive:true,force:true});process.exit(1)}); // 200 Mo par échec, jamais laissés dans /tmp
