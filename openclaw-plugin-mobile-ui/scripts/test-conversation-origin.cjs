const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'r10-transport-'));process.env.OPENCLAW_STATE_DIR=root;
 const capture=path.join(root,'gateway.jsonl'),cli=path.join(root,'gateway.cjs');process.env.R10_TEST_CAPTURE=capture;
 await fs.writeFile(cli,'#!/usr/bin/env node\nconst fs=require("node:fs");const args=process.argv.slice(2),params=JSON.parse(args[args.indexOf("--params")+1]);fs.appendFileSync(process.env.R10_TEST_CAPTURE,JSON.stringify({method:args[2],params})+"\\n");process.stdout.write(JSON.stringify({runId:params.idempotencyKey,sessionKey:"agent:main:"+params.sessionKey,status:"accepted"}));\n',{mode:0o700});process.env.CLAWMOBILE_OPENCLAW_BIN=cli;
 const {submitToOpenClawAgent,normalizeCompanionSessionId}=require('../dist/companion/openclawAgentClient');
 const {reserveSubmittedRun,terminalConversationResult,getRunStatus}=require('../dist/companion/runs');
 try{
  for(const [index,input] of ['alpha_1','beta-2'].entries()){
   const text='[companion-session:spoofed]\nA user supplied marker-shaped request';
   const reserved=await reserveSubmittedRun(text,input,'origin-'+index,{userText:text});
   const registryId=reserved.status.sessionId;assert.equal(registryId,normalizeCompanionSessionId(input));
   const result=await submitToOpenClawAgent(text,reserved.status.runId,registryId);assert.equal(result.sessionId,registryId);
   const sent=JSON.parse((await fs.readFile(capture,'utf8')).trim().split('\n').at(-1));
   assert.equal(sent.method,'agent');assert.equal(sent.params.message,`[companion-session:${registryId}]\n${text}`);
   assert.equal(sent.params.sessionKey,'companion-chat-'+registryId);assert.equal(sent.params.idempotencyKey,reserved.status.runId);assert.equal(sent.params.deliver,false);
   assert.equal(sent.params.message.split('\n')[0],`[companion-session:${registryId}]`);assert.equal(sent.params.message.split('\n')[1],'[companion-session:spoofed]');
  }
  // Synthetic fixture using the observed Gateway timestamp-before-label format; no S24 capture claimed.
  const wire='[Sat 2026-10-10 14:00 GMT+1] [companion-session:alpha]\nhello';
  const {ownerTurnEvidence}=require('../dist/companion/runInactivity');
  const {stripConversationTransport}=require('../dist/companion/conversationText');
  const now=Date.now(),messages=[{role:'user',content:wire,timestamp:now-2000},
    {role:'assistant',content:'Confirmed result',timestamp:now-1000,stopReason:'stop'}];
  const raw=messages.map(message=>JSON.stringify({type:'message',message})).join('\n');
  assert.equal(terminalConversationResult(raw,'hello').result,'Confirmed result');
  assert.ok(ownerTurnEvidence(messages,'hello',now));
  assert.equal(stripConversationTransport(wire),'hello');
  assert.equal(stripConversationTransport('[companion-session:alpha]\n[companion-session:spoofed]\nhello'),'[companion-session:spoofed]\nhello');
  assert.equal(stripConversationTransport('[Sat 2026-10-10 14:00 GMT+1] [companion-session:alpha]\n[companion-session:spoofed]\nhello'),'[companion-session:spoofed]\nhello');
  assert.equal(terminalConversationResult(raw+'\n'+raw,'hello'),undefined,'repeated equal turns remain ambiguous');
  assert.equal(ownerTurnEvidence([...messages,...messages],'hello',now),undefined);
  for(const command of ['/new','/reset','/stop','/model openai/test','  /help']){
    await submitToOpenClawAgent(command,'slash-'+command.trim().split(' ')[0].slice(1),'alpha');
    const sent=JSON.parse((await fs.readFile(capture,'utf8')).trim().split('\n').at(-1));
    assert.equal(sent.params.message,command,'Gateway slash command must stay first and unmodified');
  }
  // Actual history-display transcript path, not a second implementation of the matcher.
  const reservedHistory=await reserveSubmittedRun('display hello','display-session','history-origin',{userText:'display hello'});
  const sessions=path.join(root,'agents','main','sessions');await fs.mkdir(sessions,{recursive:true});
  await fs.writeFile(path.join(sessions,'sessions.json'),JSON.stringify({'agent:main:companion-chat-display-session':{sessionId:'display-history',updatedAt:now}}));
  const displayMessages=[{role:'user',content:'[Sat 2026-10-10 14:00 GMT+1] [companion-session:display-session]\ndisplay hello',timestamp:now-2000},
    {role:'assistant',content:'Display result',timestamp:now-1000,stopReason:'stop'}];
  await fs.writeFile(path.join(sessions,'display-history.jsonl'),displayMessages.map(message=>JSON.stringify({type:'message',message,timestamp:new Date(message.timestamp).toISOString()})).join('\n'));
  const displayed=await getRunStatus(reservedHistory.status.runId);
  assert.equal(displayed.prompt,'display hello');assert.equal(displayed.result,'Display result');
  const reporting=path.join(root,'reporting');await fs.mkdir(reporting);await fs.writeFile(path.join(reporting,'__init__.py'),'');
  const projection=path.join(root,'projection.json');
  await fs.writeFile(path.join(reporting,'control_snapshot.py'),`import json
from pathlib import Path
print(Path(__file__).parent.parent.joinpath('projection.json').read_text())
`);
  process.env.SAMANTHA_CONTROL_PLAYBOOKS=root;
  const {readControlV2}=require('../dist/companion/control');
  for(const sid of ['alpha_1',null,'agent:main:companion-chat-bad']){
   const value={schemaVersion:2,sections:{requests:{schemaVersion:2,resourceKey:'control/v2/requests/REQ-1',dataRevision:'a'.repeat(64),availability:'ready',freshness:'fresh',remainingFreshMs:1000,data:{found:true,item:{id:'REQ-1',sessionId:sid}}}}};
   for(const listing of [false,true]){
    if(listing)value.sections.requests.data={items:[{id:'REQ-1',sessionId:sid}]};
    await fs.writeFile(projection,JSON.stringify(value));
    if(sid?.includes(':'))await assert.rejects(readControlV2(['requests'],listing?undefined:'REQ-1',undefined,true));
    else{const result=await readControlV2(['requests'],listing?undefined:'REQ-1',undefined,true);assert.equal((listing?result.sections.requests.data.items[0]:result.sections.requests.data.item).sessionId,sid);}
   }
  }
  // PR48 captured contract-2 projection: legacy rows stay unlinked.
  const realRequests=JSON.parse(await fs.readFile(path.join(__dirname,'../fixtures/s24-2026-10-10/control/requests.json'),'utf8'));
  await fs.writeFile(projection,JSON.stringify(realRequests));
  const captured=await readControlV2(['requests'],undefined,undefined,true);
  assert.ok(captured.sections.requests.data.items.length>0);
  assert.ok(captured.sections.requests.data.items.every(row=>row.sessionId==null));
  console.log('R10: actual normalized registry session equals leading transport marker and Gateway route; spoofed user marker remains body data');
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1)});
