const assert=require('node:assert/strict');
const fixture=name=>structuredClone(require('../fixtures/s24-2026-10-10/ui-recette/'+name).response);
(async()=>{
 const gateway=require('../dist/companion/openclawAgentClient');
 const counts={};let release;let barrier=new Promise(r=>release=r),failOptional=false;
 gateway.callOpenClawGateway=async(method,params,options)=>{
  counts[method]=(counts[method]||0)+1;await barrier;
  if(method==='config.get')return fixture('gateway.config.get.json');
  if(method==='models.list')return fixture('gateway.models.list.json');
  if(method==='models.authStatus')return fixture('gateway.models.authStatus.json');
  if(method==='sessions.list'){
   assert.deepEqual(params,{limit:1});assert.equal(options.hardTimeoutMs,10000);
   if(failOptional)throw Error('synthetic optional read failure');
   return fixture('gateway.sessions.list.limit1.json');
  }
  if(method==='sessions.usage'){
   assert.deepEqual(params,{limit:100});assert.equal(options.hardTimeoutMs,5500);
   if(failOptional)throw Error('synthetic optional read failure');
   return structuredClone(require('../fixtures/s24-2026-10-10/p0-3/sessions.usage.json').response);
  }
  throw Error('unexpected mutation');
 };
 const api=require('../dist/companion/agentConfig');
 const cohort=async()=>{const reads=Array.from({length:12},()=>api.readAgentConfig());await new Promise(r=>setImmediate(r));release();return Promise.all(reads);};
 const first=await cohort();assert.equal(first.length,12);
 for(const method of ['config.get','models.list','models.authStatus','sessions.list','sessions.usage'])assert.equal(counts[method],1,method+' shared for simultaneous readers');
 assert.ok(first.every(value=>JSON.stringify(value)===JSON.stringify(first[0])),'same public projection');
 const index=require('../dist/companion/conversationOwnerIndex');index.invalidateSessionDefaults();
 const realNow=Date.now;let clock=realNow()+61000;Date.now=()=>clock;
 try{
  counts['sessions.list']=counts['sessions.usage']=0;failOptional=true;
  barrier=new Promise(r=>release=r);const failed=await cohort();
  assert.ok(failed.every(value=>value.usage===null));
  assert.equal(counts['sessions.list'],1);assert.equal(counts['sessions.usage'],1);
  failOptional=false;barrier=new Promise(r=>release=r);const recovered=await cohort();
  assert.equal(counts['sessions.list'],2,'failure releases flight for next request');
  assert.equal(counts['sessions.usage'],2,'failure does not poison usage cache');
  assert.ok(recovered.every(value=>value.usage!==null));
  await api.readAgentConfig();assert.equal(counts['sessions.usage'],2,'existing sixty-second TTL retained');
  assert.equal(counts['config.get'],4,'each fresh cohort and subsequent read retain fresh config');
 }finally{Date.now=realNow;}
 console.log(JSON.stringify({suite:'agent-config-flight',passed:true,concurrentReaders:12,source:'cleaned S24 captures 2026-10-10; scheduling and failure injection synthetic',productionTimingQualified:false}));
})().catch(error=>{console.error(error);process.exitCode=1});
