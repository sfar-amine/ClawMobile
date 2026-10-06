const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'samantha-hydration-races-'));
process.env.OPENCLAW_STATE_DIR=root;const folder=path.join(root,'clawmobile-companion');fs.mkdirSync(folder);
const file=path.join(folder,'runs.json'),started=path.join(root,'started'),released=path.join(root,'released');
const fake=path.join(root,'gateway.sh');
fs.writeFileSync(fake,`#!/bin/sh\ntouch '${started}'\nwhile [ ! -e '${released}' ]; do sleep 0.02; done\nprintf '%s' '{"messages":[{"role":"user","content":[{"type":"text","text":"A unique fixture request"}],"timestamp":2000},{"role":"assistant","content":[{"type":"text","text":"Proved terminal result"}],"timestamp":3000,"stopReason":"stop"}]}'\n`);fs.chmodSync(fake,0o700);
process.env.CLAWMOBILE_OPENCLAW_BIN=fake;
const api=require('../dist/companion/runs');
const base=(session)=>({version:1,runs:[{runId:'run-'+session,sessionId:session,text:'A unique fixture request',userText:'A unique fixture request',acceptedAt:1000,updatedAt:1001,state:'running'}],archivedSessionIds:[],paymentRequests:[{id:'guard-pay'}],ownerConfirmations:[{id:'guard-confirm'}]});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function waitStart(){for(let i=0;i<250;i++){if(fs.existsSync(started))return;await pause(20)}throw Error('fixture_not_started')}
async function fixture(session,mutate){
 for(const f of [started,released])try{fs.unlinkSync(f)}catch{}
 fs.writeFileSync(file,JSON.stringify(base(session)));
 const running=api.getConversationTurns(session);await waitStart();await mutate(session);
 fs.writeFileSync(released,'release');const result=await running;const stored=JSON.parse(fs.readFileSync(file));
 assert.deepEqual(stored.paymentRequests,[{id:'guard-pay'}]);assert.deepEqual(stored.ownerConfirmations,[{id:'guard-confirm'}]);
 return {result,stored};
}
(async()=>{
 const deleted=await fixture('delete-test',s=>api.deleteSession(s));assert.equal(deleted.result.length,0);assert.equal(deleted.stored.runs.length,0);
 const archived=await fixture('archive-test',s=>api.archiveSession(s));assert.equal(archived.result.length,0);assert.equal(archived.stored.runs[0].result,undefined);
 const failed=await fixture('failed-test',s=>api.markSubmittedRunFailed('run-'+s,'Fixture definitive failure'));
 assert.equal(failed.stored.runs[0].state,'failed');assert.equal(failed.stored.runs[0].result,undefined);assert.equal(failed.result[0].state,'failed');
 const resolved=await fixture('resolved-test',async()=>{});
 assert.equal(resolved.stored.runs[0].result,'Proved terminal result');assert.equal(resolved.stored.runs[0].updatedAt,3000);
 console.log(JSON.stringify({suite:'backfill-races',passed:true,cases:['delete','archive','newer-failure','source-terminal-timestamp'],guardsPreserved:true}));
})().catch(e=>{try{fs.writeFileSync(released,'release')}catch{};console.error(e);process.exitCode=1});
