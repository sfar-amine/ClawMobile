const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {EventEmitter} = require('node:events');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'qa-notification-'));
const captured = path.join(temporary,'captured.json');
fs.writeFileSync(path.join(temporary,'termux-notification'), '#!/usr/bin/env node\nrequire("fs").writeFileSync('+JSON.stringify(captured)+',JSON.stringify(process.argv.slice(2)));\n');
fs.chmodSync(path.join(temporary,'termux-notification'),0o700);
process.env.CLAW_MOBILE_TERMUX_BIN=temporary;
const action = require('../dist/backends/qaCampaignNotificationAction.js');
const backend = require('../dist/backends/termux.js');
const producer = require('../dist/backends/qaCampaignNotificationCli.js');
let checks=0;
function check(fn){fn();checks++;}
(async()=>{
  for(const bad of ['',null,1,'../run','run;touch x','run\nsecret','$(id)','a'.repeat(97),' run']) {
    check(()=>assert.throws(()=>action.qaCampaignOpenArgs(bad),/run_id_invalid/));
    check(()=>assert.throws(()=>backend.qaCampaignNotificationArgs(bad),/run_id_invalid/));
  }
  const runId='qa-20261018.1';
  const expected=['start','-n','ai.samantha.android.dev/ai.samantha.android.MainActivity',
    '-a','ai.samantha.android.OPEN_QA_CAMPAIGN','--ei','qa_version','1','--es','qa_run_id',runId];
  check(()=>assert.deepEqual(action.qaCampaignOpenArgs(runId),expected));
  const receipt=await producer.notifyQaCampaign([runId]);
  check(()=>assert.deepEqual(receipt,{state:'ACCEPTED',display_verified:false,click_verified:false}));
  const args=JSON.parse(fs.readFileSync(captured));
  check(()=>assert.equal(args[args.indexOf('--id')+1],'qa-campaign:'+runId));
  check(()=>assert(args.includes('--alert-once')));
  const shell=args[args.indexOf('--action')+1];
  check(()=>assert(shell.includes("'"+path.resolve(__dirname,'../dist/backends/qaCampaignNotificationAction.js')+"'")));
  check(()=>assert(shell.startsWith("'/data/data/com.termux/files/home/.openclaw-android/bin/node' ")));
  check(()=>assert(shell.endsWith("'"+runId+"'")));
  check(()=>assert(!shell.includes('Campagne')&&!shell.includes('am start')));
  check(()=>assert(!args.includes('--on-delete')));
  // Public producer cannot turn arbitrary request keys into a shell command.
  await backend.tx_notify({title:'visible',content:'body',action:'EVIL',runId});
  check(()=>assert.deepEqual(JSON.parse(fs.readFileSync(captured)),['--title','visible','--content','body']));
  await assert.rejects(()=>producer.notifyQaCampaign([runId,'EXTRA']),/arguments_invalid/);checks++;
  await assert.rejects(()=>backend.tx_notify({title:'x',content:'y'},{kind:'arbitrary',runId}),/kind_invalid/);checks++;
  const before=fs.readFileSync(captured,'utf8');
  const invalid=cp.spawnSync(process.execPath,[path.resolve(__dirname,'../dist/backends/qaCampaignNotificationCli.js'),'$(evil)'],{encoding:'utf8'});
  check(()=>assert.deepEqual(JSON.parse(invalid.stdout),{state:'NOT_SENT',reason:'qa_notification_request_invalid'}));
  check(()=>assert.equal(invalid.status,1));
  check(()=>assert.equal(fs.readFileSync(captured,'utf8'),before));
  const realSpawn=cp.spawn;let calls=[];
  cp.spawn=(file,args,options)=>{calls.push({file,args,options});const child=new EventEmitter();child.kill=()=>{};process.nextTick(()=>child.emit('close',0));return child;};
  try {
    check(()=>assert.equal(calls.length,0));
    assert.equal(await action.openQaCampaign([runId]),0);checks++;
    check(()=>assert.deepEqual(calls,[{file:'/data/data/com.termux/files/usr/bin/am',args:expected,options:{stdio:'ignore'}}]));
    await assert.rejects(()=>action.openQaCampaign(['$(evil)']),/run_id_invalid/);checks++;
    check(()=>assert.equal(calls.length,1));
  } finally {cp.spawn=realSpawn;}
  console.log(`${checks}/${checks} QA notification checks passed; no real notification or Android launch`);
})().finally(()=>fs.rmSync(temporary,{recursive:true,force:true})).catch(error=>{console.error(error);process.exitCode=1;});
