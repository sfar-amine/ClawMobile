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
  const outcome=await bridge.pruneRemoteBridgeReadReceipts();
  assert.equal(outcome.removed,60);assert.equal(outcome.retainedRead,50000);
  assert(!fs.existsSync(path.join(dir,'r0.json')));assert(fs.existsSync(path.join(dir,'r50059.json')));
  for(const [id,row] of Object.entries(protectedRows))assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,id+'.json'),'utf8')),row);
  assert(fs.existsSync(outside));assert.equal(fs.readFileSync(path.join(dir,'invalid.json'),'utf8'),'{');
  assert.equal((await bridge.pruneRemoteBridgeReadReceipts()).removed,0);
  await assert.rejects(()=>bridge.pruneRemoteBridgeReadReceipts(0),/invalid_receipt_retention/);
  // A symlinked request directory is not the attested owner's directory.
  const original=path.join(root,'preserved-requests');fs.renameSync(dir,original);fs.symlinkSync(original,dir);
  assert.equal((await bridge.pruneRemoteBridgeReadReceipts()).state,'source_unavailable');
  assert(fs.existsSync(path.join(original,'write.json')));
  console.log('P0-5: 50,060 read receipts bounded; active/uncertain/mutation/effect proofs preserved; repeat has no effect. Synthetic owner volume, no S24 qualification.');
})().finally(()=>fs.rmSync(root,{recursive:true,force:true})).catch(e=>{console.error(e);process.exitCode=1;});
