const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-retention-'));
process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR=root;
const bridge=require('../dist/companion/remoteBridge');
const dir=path.join(root,'requests');fs.mkdirSync(dir);
function receipt(id,extra={}){return {requestId:id,method:'ping',paramsHash:'a'.repeat(64),state:'completed',
  mutationRisk:'read',receivedAt:1700000000000,completedAt:1700000000001,...extra};}
(async()=>{
  // Realistic volume, canonical Git owner shape; no S24 capture claimed.
  for(let i=0;i<50060;i++)fs.writeFileSync(path.join(dir,`r${i}.json`),JSON.stringify(receipt(`r${i}`,{completedAt:1700000000001+i})));
  const protectedRows={
    write:receipt('write',{method:'write_file',mutationRisk:'write'}),
    unknown:receipt('unknown',{mutationRisk:'unknown'}),
    running:receipt('running',{state:'running'}), received:receipt('received',{state:'received'}),
    indeterminate:receipt('indeterminate',{state:'indeterminate'}),
    noTime:receipt('noTime',{completedAt:null}),
    spoofRead:receipt('spoofRead',{method:'write_file'}),
    fence:receipt('fence',{continuumFence:{version:1,effectKey:'preserve'}})
  };
  for(const [id,row] of Object.entries(protectedRows))fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify(row));
  fs.writeFileSync(path.join(dir,'invalid.json'),'{');
  const outside=path.join(root,'outside-proof.json');fs.writeFileSync(outside,JSON.stringify(receipt('linked')));
  fs.symlinkSync(outside,path.join(dir,'linked.json'));
  // Retention semantics do not depend on host speed. Dedicated clock probes below cover the admission deadline.
  const pruning=bridge.pruneRemoteBridgeReadReceipts(undefined,{now:()=>0});
  assert.equal((await bridge.pruneRemoteBridgeReadReceipts()).state,'busy');
  const outcome=await pruning;
  assert.equal(outcome.removed,60);assert.equal(outcome.retainedRead,50000);
  assert(!fs.existsSync(path.join(dir,'r0.json')));assert(fs.existsSync(path.join(dir,'r50059.json')));
  for(const [id,row] of Object.entries(protectedRows))assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,id+'.json'),'utf8')),row);
  assert(fs.existsSync(outside));assert.equal(fs.readFileSync(path.join(dir,'invalid.json'),'utf8'),'{');
  assert.equal((await bridge.pruneRemoteBridgeReadReceipts(undefined,{now:()=>0})).removed,0);
  await assert.rejects(()=>bridge.pruneRemoteBridgeReadReceipts(0),/invalid_receipt_retention/);
  await assert.rejects(()=>bridge.pruneRemoteBridgeReadReceipts(1,{budgetMs:0}),/invalid_receipt_retention_budget/);
  const before=fs.readdirSync(dir).length;
  let tick=0;
  const expired=await bridge.pruneRemoteBridgeReadReceipts(1,{budgetMs:1,now:()=>tick++});
  assert.equal(expired.state,'partial');assert.equal(expired.reason,'budget_exceeded');assert.equal(expired.removed,0);
  assert.equal(fs.readdirSync(dir).length,before);
  const badClock=await bridge.pruneRemoteBridgeReadReceipts(1,{now:()=>NaN});
  assert.equal(badClock.state,'partial');assert.equal(badClock.reason,'clock_invalid');assert.equal(badClock.removed,0);
  const opendir=fs.promises.opendir;
  const rows=['r60','r61','r62'];
  try {
    fs.promises.opendir=async()=>({async *[Symbol.asyncIterator](){for(const id of rows)yield{name:id+'.json',isFile:()=>true};}});
    const times=[0,0,0,0,0,2];
    const expiredAfterInventory=await bridge.pruneRemoteBridgeReadReceipts(1,{budgetMs:1,now:()=>times.shift()??2});
    assert.equal(expiredAfterInventory.state,'partial');assert.equal(expiredAfterInventory.removed,0);
    assert.equal(fs.readdirSync(dir).length,before);
    // The receipt changed after inventory: the hash guard must preserve its new active/mutation state.
    const changed=receipt('r60',{method:'write_file',mutationRisk:'write',state:'running'});
    fs.promises.opendir=async()=>({async *[Symbol.asyncIterator](){
      for(const id of rows)yield{name:id+'.json',isFile:()=>true};
      fs.writeFileSync(path.join(dir,'r60.json'),JSON.stringify(changed));
    }});
    const guarded=await bridge.pruneRemoteBridgeReadReceipts(1,{now:()=>0});
    assert.equal(guarded.state,'applied');assert.equal(guarded.removed,1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'r60.json'),'utf8')),changed);
    assert.equal(fs.existsSync(path.join(dir,'r61.json')),false);assert.equal(fs.existsSync(path.join(dir,'r62.json')),true);
    fs.promises.opendir=async()=>({async *[Symbol.asyncIterator](){
      for(let i=0;i<100001;i++)yield{name:'preserve-'+i,isFile:()=>false};
    }});
    const capped=await bridge.pruneRemoteBridgeReadReceipts(1,{now:()=>0});
    assert.equal(capped.state,'partial');assert.equal(capped.reason,'inventory_limit');assert.equal(capped.scanned,100000);
    assert.equal(capped.removed,0);assert.equal(fs.existsSync(path.join(dir,'r62.json')),true);
  } finally {fs.promises.opendir=opendir;}
  // A symlinked request directory is not the attested owner's directory.
  const original=path.join(root,'preserved-requests');fs.renameSync(dir,original);fs.symlinkSync(original,dir);
  assert.equal((await bridge.pruneRemoteBridgeReadReceipts()).state,'source_unavailable');
  assert(fs.existsSync(path.join(original,'write.json')));
  console.log('P0-5: 50,060 read receipts bounded; active/uncertain/mutation/effect proofs preserved; busy/deadline/inventory/hash guards and idempotence verified. Synthetic owner volume, no S24 qualification.');
})().finally(()=>fs.rmSync(root,{recursive:true,force:true})).catch(e=>{console.error(e);process.exitCode=1;});
