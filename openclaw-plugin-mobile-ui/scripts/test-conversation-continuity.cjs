const assert=require('assert');
const fs=require('fs');const os=require('os');const path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'samantha-continuity-'));
process.env.OPENCLAW_STATE_DIR=root;
const client=require('../dist/companion/openclawAgentClient.js');
let reads=0;
client.callOpenClawGateway=async(method,params)=>{
 if(method==='sessions.list')return {sessions:[]};
 assert.equal(method,'chat.history');reads++;
 return {messages:[{role:'user',content:[{type:'text',text:'Text context: blue'}],timestamp:1000},
 {role:'assistant',content:[{type:'text',text:'The chosen colour is blue.'}],timestamp:2000}]};
};
const modulePath=require.resolve('../dist/companion/runs.js');let runs=require(modulePath);
const id='voice-11111111-1111-4111-8111-111111111111';
const turn={runId:id,revision:1,input:'Voice: green instead.',output:'',state:'partial'};
(async()=>{
 await runs.rememberSubmittedRun('Text context: blue',{runId:'text1',sessionId:'samantha-test',acceptedAt:1000,waitedForFinal:false,raw:{}},{userText:'Text context: blue'});
 await runs.saveVoiceTurn('samantha-test',turn);
 await runs.saveVoiceTurn('samantha-test',turn); // Lost response, same mutation: one row.
 let rows=await runs.getConversationTurns('samantha-test');
 assert.equal(rows.length,2);assert.equal(rows[0].result,'The chosen colour is blue.');assert.equal(reads,1);
 assert.equal(rows[1].modality,'voice');assert.equal(rows[1].state,'unknown');
 await runs.saveVoiceTurn('samantha-test',{...turn,revision:2,output:'Green is now selected.',state:'completed'});
 await runs.saveVoiceTurn('samantha-test',turn); // Stale packet cannot overwrite completed transcript.
 rows=await runs.getConversationTurns('samantha-test');assert.equal(rows[1].result,'Green is now selected.');assert.equal(rows[1].state,'done');
 assert.equal((await runs.getRunStatus(id)).result,'Green is now selected.');
 assert.equal((await runs.listRuns()).filter(row=>row.runId===id).length,1);
 await assert.rejects(runs.saveVoiceTurn('another-thread',turn),/identity_conflict/);
 await assert.rejects(runs.saveVoiceTurn('samantha-test',{...turn,revision:3,output:'wrong'}),/already_final/);
 await assert.rejects(runs.saveVoiceTurn('samantha-test',{...turn,audio:'pcm'}),/invalid_voice_transcript/);
 await assert.rejects(runs.saveVoiceTurn('../outside',turn),/invalid_session_id/);
 assert.deepEqual(await runs.getConversationTurns('another-thread'),[]);
 const prompt=await runs.appendVoiceConversationContext('What colour?', 'samantha-test');
 assert(prompt.includes('Green is now selected.'));assert(prompt.endsWith('Current user request:\nWhat colour?'));
 assert.equal(await runs.appendVoiceConversationContext('What colour?', 'another-thread'),'What colour?');
 // Actual module reload reads the same existing registry, no second history store.
 delete require.cache[modulePath];runs=require(modulePath);
 assert.equal((await runs.getRunStatus(id)).result,'Green is now selected.');
 await Promise.all(Array.from({length:12},(_,i)=>runs.saveVoiceTurn('samantha-concurrent',{
 ...turn,runId:'voice-'+String(i).padStart(8,'0')+'-1111-4111-8111-111111111111',state:'completed'})));
 const concurrent=await runs.getConversationTurns('samantha-concurrent');assert.equal(concurrent.length,12);
 await runs.deleteSession('samantha-concurrent');
 await assert.rejects(runs.saveVoiceTurn('samantha-concurrent',{...turn,runId:'voice-22222222-2222-4222-8222-222222222222'}),/archived/);
 assert.deepEqual(await runs.getConversationTurns('samantha-concurrent'),[]);
 const registry=path.join(root,'clawmobile-companion','runs.json');
 fs.writeFileSync(registry,'corrupt');
 await assert.rejects(runs.saveVoiceTurn('samantha-test',turn));assert.equal(fs.readFileSync(registry,'utf8'),'corrupt');
 console.log('Conversation continuity PASS: same thread, text/voice context, ordered idempotent checkpoints, restart, isolation, concurrent writes, archived and corrupt-store protection.');
})().finally(()=>fs.rmSync(root,{recursive:true,force:true})).catch(e=>{console.error(e);process.exitCode=1});
