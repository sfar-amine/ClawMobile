const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http');
const captured=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../fixtures/s24-2026-10-10/gateway/usage.status.json')));
const client=require('../dist/companion/openclawAgentClient');
const counts={};let usageFail=false;let synthetic=false;let now=Date.now();const realNow=Date.now;Date.now=()=>now;
const config={agents:{entries:{main:{model:{primary:'github-copilot/fixture-model',fallbacks:['openai/fallback']},modelPolicy:{allow:['github-copilot/fixture-model','openai/fallback']}}}},plugins:{entries:{'samantha-mobile-ui':{enabled:true}}}};
client.callOpenClawGateway=async(method,params,options)=>{
 counts[method]=(counts[method]||0)+1;
 assert.ok(options.hardTimeoutMs<=5500);
 if(method==='usage.status'){await new Promise(r=>setTimeout(r,synthetic?5:3200));if(usageFail)throw Error('fixture failure');return structuredClone(captured);}
 if(method==='usage.cost'){assert.deepEqual(params,{days:30});return {updatedAt:now,days:30,totals:{totalCost:42},daily:[],private:'owner@example.invalid'};}
 if(method==='config.get')return {hash:'a'.repeat(64),config};
 if(method==='models.list')return {models:[{provider:'github-copilot',id:'fixture-model',name:'Fixture model',available:true,reasoning:true,input:['image'],contextTokens:64000},{provider:'openai',id:'fallback',available:true},{provider:'unused',id:'not-configured',available:true}]};
 if(method==='models.authStatus')return {providers:[{provider:'github-copilot',status:'ok'},{provider:'openai',status:'ok'},{provider:'unused',status:'expired'},{provider:'custom',status:'missing'}]};
 throw Error('Unexpected Gateway method');
};
const usage=require('../dist/companion/usage'),providers=require('../dist/companion/providers'),owner=require('../dist/companion/modelOwner'),control=require('../dist/companion/usageControl');
function noLeaks(value){const text=JSON.stringify(value);assert.ok(!/@|Bearer|api_key|password|gho_|ghs_|github_pat_|https?:|mailto:|javascript:|data:|eyJabcdefgh|AKIA/.test(text),text);}
const malicious=['owner@example.invalid','api_key=fixture-value','password:fixture-value','Bearer abcdefghijkl','gho_abcdefghijklm','ghs_abcdefghijklm','github_pat_abcdefghijk','https://user:pass@host.invalid','https://host.invalid','mailto:private','javascript:alert(1)','data:text/plain,abc','eyJabcdefgh.abcdefgh.abcdefgh','AKIA1234567890ABCDEF'];
(async()=>{
 let assertions=0;
 const view=usage.projectUsage(captured);assert.equal(view.providers[0].state,'exhausted');assert.equal(view.providers[1].state,'ok');assert.equal(view.providers[1].windows[0].resetsAt,1794219642000);assert.equal(view.providers[0].windows[0].remainingPercent,0);noLeaks(view);assert.deepEqual(Object.keys(view).sort(),['issues','providers','schemaVersion','updatedAt']);
 for(const payload of malicious){
  for(const field of ['provider','displayName','plan']){const input=structuredClone(captured);input.providers[0][field]=payload;noLeaks(usage.projectUsage(input));assertions++;}
  const input=structuredClone(captured);input.providers[0].windows[0].label=payload;noLeaks(usage.projectUsage(input));assertions++;
 }
 assert.equal(usage.projectUsage({providers:[{provider:'fixture',windows:[]}]}).providers[0].state,'unknown');
 for(const used of [undefined,null,'100',NaN,-1])assert.equal(usage.projectUsage({providers:[{provider:'fixture',windows:[{usedPercent:used}]}]}).providers[0].state,'unknown');
 for(const [percent,state] of [[79,'ok'],[80,'low'],[99,'low'],[100,'exhausted'],[101,'exhausted']])assert.equal(usage.projectUsage({providers:[{provider:'fixture',windows:[{usedPercent:percent}]}]}).providers[0].state,state);
 assert.equal(usage.projectUsage({providers:[{provider:'fixture',windows:[{usedPercent:100},{}]}]}).providers[0].state,'exhausted');
 const began=performance.now();const results=await Promise.all(Array.from({length:10},()=>usage.readUsage()));assert.equal(counts['usage.status'],1);assert.ok(performance.now()-began>=3150&&performance.now()-began<6000);results[0].providers.length=0;assert.equal(results[1].providers.length,2);synthetic=true;
 assert.equal(counts['usage.cost'],undefined);
 assert.equal((await usage.readUsageCost()).state,'unqualified');assert.equal(counts['usage.cost'],1);
 const shared=await Promise.all(Array.from({length:10},()=>providers.readProviders()));assert.equal(counts['config.get'],1);assert.equal(counts['models.list'],1);assert.equal(counts['models.authStatus'],1);assert.equal(counts['usage.status'],1);
 const active=shared[0].providers.find(p=>p.id==='github-copilot');assert.equal(active.state,'exhausted');assert.equal(active.models[0].inUse,'primary');assert.equal(active.models[0].contextTokens,64000);assert.deepEqual(active.models[0].capabilities,['reasoning','image']);assert.deepEqual(shared[0].providers.find(p=>p.id==='unused').models,[]);assert.deepEqual(shared[0].providers.find(p=>p.id==='custom').models,[]);noLeaks(shared[0]);assert.ok(!shared[0].providers.some(p=>p.id==='samantha-mobile-ui'));
 for(const payload of malicious){const raw=structuredClone(owner.peekModelOwner());raw.catalog.models[0].name=payload;raw.catalog.models[1].id=payload;raw.auth.providers.push({provider:payload,status:'ok'});raw.config.agents.entries.main.model.primary=payload;noLeaks(providers.projectProviders(raw,view));assertions++;}
 const legacy=structuredClone(owner.peekModelOwner());legacy.config.agents.list=[{id:'main',model:'github-copilot/fixture-model'}];legacy.config.agents.entries={};legacy.config.agents.defaults={model:{primary:'unused/ignored',fallbacks:['openai/fallback']}};const legacyView=providers.projectProviders(legacy,view);assert.equal(legacyView.providers.find(p=>p.id==='github-copilot').models[0].inUse,'primary');assert.equal(legacyView.providers.find(p=>p.id==='openai').models[0].inUse,'fallback');
 const missing=providers.projectProviders(null,view);assert.ok(missing.providers.every(p=>p.state==='unknown'&&p.auth==='unknown'));
 const before=JSON.stringify(counts);const enriched=control.completeUsageAttention({schemaVersion:2,sections:{health:{data:{attentionItems:[]},dataRevision:'old'}}});assert.ok(enriched.sections.health.data.attentionItems.some(x=>x.id==='usage:github-copilot'&&x.activeAgentDependency));assert.ok(enriched.sections.health.data.attentionItems.some(x=>x.id==='provider:github-copilot'));assert.equal(JSON.stringify(counts),before);noLeaks(enriched);const direct=control.completeUsageAttention({data:{attentionItems:[]},dataRevision:'old'});assert.ok(direct.data.attentionItems.some(x=>x.id==='usage:github-copilot'));assert.notEqual(direct.dataRevision,'old');
 await providers.readProviders(true);const refreshed=counts['config.get'];await providers.readProviders(true);assert.equal(counts['config.get'],refreshed);now+=30000;await providers.readProviders(true);assert.equal(counts['config.get'],refreshed+1);
 now+=60001;const expired=control.completeUsageAttention(enriched);assert.deepEqual(expired.sections.health.data.attentionItems,[]);usageFail=true;await Promise.all(Array.from({length:10},()=>usage.readUsage()));const failedCount=counts['usage.status'];assert.deepEqual((await usage.readUsage()).issues,['usage_source_unavailable']);assert.equal(counts['usage.status'],failedCount);usageFail=false;
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(path,headers={},method='GET')=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path,headers,method},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(text||'{}')}));});req.on('error',reject);req.end();});
 try{for(const path of ['/v1/usage','/v1/providers']){assert.equal((await request(path)).status,200);for(const headers of [{origin:'https://fixture.invalid'},{referer:'https://fixture.invalid'},{'sec-fetch-site':'same-origin'}])assert.equal((await request(path,headers)).status,403);assert.equal((await request(path,{},'POST')).status,405);assert.equal((await request(path+'?unknown=1')).status,400);}assert.equal((await request('/v1/usage?details=cost')).value.state,'unqualified');assert.equal(counts['usage.cost'],2);assert.equal((await request('/v1/usage?details=cost&details=cost')).status,400);assert.equal((await request('/v1/providers?refresh=2')).status,400);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));Date.now=realNow;}
 console.log('R19 captured usage + R21 synthetic owner: '+assertions+' privacy variants; quota/missing/singleflight/3.2s injected delay/refresh/Control no-I/O/HTTP passed. Model/auth/cost S24 qualification absent.');
})().catch(error=>{Date.now=realNow;console.error(error);process.exitCode=1;});
