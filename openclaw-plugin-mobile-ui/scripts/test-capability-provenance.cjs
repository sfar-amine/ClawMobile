const assert=require('node:assert/strict'), fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'o7-provenance-'));process.env.OPENCLAW_STATE_DIR=root;
const {capabilityProvenance}=require('../dist/companion/capabilityProvenance.js');
const runs=require('../dist/companion/runs.js');
async function main(){
 const p={capability:'orange.balance',route:'orange.balance.auto',network_path:'wifi_off',network_guard:{SSID:'private-value'},result:{raw:'private-value'}};
 assert.deepEqual(capabilityProvenance(p),{capability:'orange.balance',route:'orange.balance.auto',network_path:'wifi_off'});
 for(const value of ['x'.repeat(161),'https://private.example','owner@example.invalid',null])assert.equal(capabilityProvenance({...p,route:value}),undefined);
 const reservation=await runs.reserveSubmittedRun('test reading','o7-test','o7-client',{executionSource:'capability_first'});
 await runs.settleSubmittedRun(reservation.status.runId,'done','Compte : 3 TND',{provenance:p});
 const file=path.join(root,'clawmobile-companion/runs.json');let store=JSON.parse(fs.readFileSync(file));
 assert.deepEqual(store.runs[0].provenance,capabilityProvenance(p));assert(!JSON.stringify(store).includes('private-value'));
 assert.deepEqual((await runs.getRunStatus(reservation.status.runId)).provenance,capabilityProvenance(p));
 // Real S24 capture (10/10 09:41): capability from the decision, route really executed by the owner, no O1 path.
 const capture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/o7-o8-orange-20261010-0941.json')));
 const real={capability:capture.decision_envelope.capability,route:capture.client_received_result.route_id,result:capture.client_received_result};
 const captured=await runs.reserveSubmittedRun(capture.companion_run.userText,'o7-test','o7-capture',{executionSource:'capability_first'});
 await runs.settleSubmittedRun(captured.status.runId,'done','Bonus internet mobile : 9.49 GO',{provenance:real});
 assert.deepEqual((await runs.getRunStatus(captured.status.runId)).provenance,{capability:'telecom.orange.consultation',route:'orange.usage.maxit.v1'});
 store=JSON.parse(fs.readFileSync(file));assert(!JSON.stringify(store).includes('https_waaat'));assert(!JSON.stringify(store).includes('"cards"'));
 // Seed realistic run history directly; use existing owner retention on next write.
 const payments=store.paymentRequests, confirmations=store.ownerConfirmations;
 store.runs=Array.from({length:10000},(_,i)=>({...store.runs.find(r=>r.runId===reservation.status.runId),runId:'historical-'+i,clientRunId:'historical-client-'+i,text:'history',provenance:p}));fs.writeFileSync(file,JSON.stringify(store));
 const fresh=await runs.reserveSubmittedRun('test bounded','o7-test','o7-volume',{executionSource:'capability_first'});
 await runs.settleSubmittedRun(fresh.status.runId,'done','Compte : 3 TND',{provenance:p});
 store=JSON.parse(fs.readFileSync(file));assert(store.runs.length<=500);assert(fs.statSync(file).size<8*1024*1024);
 for(const row of store.runs)assert(!row.provenance||Buffer.byteLength(JSON.stringify(row.provenance))<400);
 assert.deepEqual(store.paymentRequests,payments);assert.deepEqual(store.ownerConfirmations,confirmations);
 assert(!JSON.stringify(store).includes('private-value'));console.log('O7 provenance persisted/projected/bounded: PASS (10000 seeded runs, max500 retained)');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
