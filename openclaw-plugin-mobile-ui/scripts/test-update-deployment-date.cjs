const assert=require('node:assert/strict');
(async()=>{
 const {withCompanionDeploymentDate:bind}=require('../dist/companion/updateDeploymentDate');
 const captured=require('../fixtures/s24-2026-10-10/p0-3/updates.json');assert.equal(captured._capture.sanitized,true);
 const original=captured.response,source=JSON.stringify(original),target='a'.repeat(40);let calls=0;
 const unknown=await bind(original,target,async commit=>{calls++;assert.equal(commit,target);return null;});
 assert.equal(unknown.items.find(x=>x.id==='companion').deployedAt,null);assert.equal(JSON.stringify(original),source);
 for(const row of original.items){const changed=unknown.items.find(x=>x.id===row.id);assert.deepEqual(changed,row.id==='companion'?{...row,deployedAt:null}:row);}
 assert.equal(calls,1);await bind(original,null,async()=>{throw Error('must not query owner without target');});
 // Pure normalization cases are synthetic, not deployment proofs or S24 dates.
 for(const date of ['2026-10-10T12:30:00+00:00','2026-10-10T13:30:00.123456+01:00']){
  const projected=await bind(original,target,async()=>date);assert.equal(projected.items.find(x=>x.id==='companion').deployedAt,new Date(date).toISOString());
  assert.equal(projected.items.find(x=>x.id==='companion').version,original.items.find(x=>x.id==='companion').version);
 }
 for(const date of ['not-a-date','2026-10-10','2026-02-30T00:00:00Z','2026-10-10T24:00:00Z',42,undefined])assert.equal((await bind(original,target,async()=>date)).items.find(x=>x.id==='companion').deployedAt,null);
 assert.equal((await bind(original,target,async()=>{throw Error('owner unavailable');})).items.find(x=>x.id==='companion').deployedAt,null);
 console.log(JSON.stringify({suite:'G5-deployment-date-binding',passed:true,updatesFixture:'p0-3/updates.json',qualification:'pure binding; positive real G4 receipt and route wiring pending'}));
})().catch(e=>{console.error(e);process.exitCode=1});
