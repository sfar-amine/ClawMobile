const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {callOpenClawGateway} = require('../dist/companion/openclawAgentClient');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'strict-group-cleanup-'));
  const bin = path.join(root, 'fake-cli');
  const pidFile = path.join(root, 'group.json');
  const oldBin = process.env.CLAWMOBILE_OPENCLAW_BIN;
  const kill = process.kill;
  const openDirectory = syncFs.opendirSync;
  await fs.writeFile(bin, `#!/usr/bin/env node
const fs = require('fs'), {spawn} = require('child_process');
const mode = JSON.parse(process.argv[process.argv.indexOf('--params') + 1]).mode;
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], {stdio:['ignore','pipe','ignore']});
child.stdout.once('data', () => {
  fs.writeFileSync(${JSON.stringify(pidFile)}+'.tmp', JSON.stringify({parent:process.pid, child:child.pid}));
  fs.renameSync(${JSON.stringify(pidFile)}+'.tmp', ${JSON.stringify(pidFile)});
  if(mode==='term_reaped') process.on('SIGTERM',()=>{child.once('close',()=>process.exit(0));child.kill('SIGKILL');});
  if(mode==='stdout'||mode==='term_reaped') process.stdout.write('x'.repeat(4096));
  if(mode==='stderr') process.stderr.write('x'.repeat(4096));
  if(mode==='invalid_json'){process.stdout.write('not json');process.exit(0);}
  if(mode==='nonzero_exit') process.exit(1);
});
setInterval(()=>{},1000);
`, {mode:0o700});
  process.env.CLAWMOBILE_OPENCLAW_BIN = bin;
  const options = {timeoutMs:1000, hardTimeoutMs:500,
    strictOutput:{stdoutMaxBytes:256, stderrMaxBytes:256, killGraceMs:100}};
  let passed = 0; const results = [];
  try {
    for (const mode of ['stdout', 'stderr', 'deadline', 'invalid_json', 'nonzero_exit', 'term_reaped', 'delayed_kill', 'unreadable', 'census_limit']) {
     // Under CI load the fake CLI (a fresh Node process) may not reach `ready` before the 500 ms hard deadline:
     // the case then never spawned its descendant and proves nothing. Retry only that fixture start-up (max 3);
     // every bound and cleanup assertion below is unchanged for the attempt that ran.
     for (let attempt = 1; ; attempt++) {
      await fs.rm(pidFile, {force:true});
      let killDelivered = false;
      if(mode==='delayed_kill') process.kill = function(pid,signal){
        if(pid<0&&signal==='SIGKILL'&&!killDelivered){setTimeout(()=>{try{kill.call(process,pid,signal);}catch{}killDelivered=true;},20);return true;}
        return kill.call(process,pid,signal);
      };
      if (mode==='unreadable' || mode==='census_limit') {
        // Only the visibility probe is replaced. Signals still reach real processes.
        process.kill = function(pid, signal) {
          if(pid<0 && signal===0) return true;
          return kill.call(process,pid,signal);
        };
        syncFs.opendirSync = mode==='unreadable'
          ? () => {throw Object.assign(new Error('synthetic unreadable proc'),{code:'EACCES'});}
          : () => ({readSync:()=>({name:'non_numeric'}),closeSync:()=>{}});
      }
      const start = Date.now();
      let failure;
      await assert.rejects(callOpenClawGateway('agents.files.list', {mode:['unreadable','census_limit','delayed_kill'].includes(mode)?'stdout':mode}, options), error => {
        failure = error;
        return error.message==='gateway_read_failed';
      });
      process.kill = kill;
      syncFs.opendirSync = openDirectory;
      assert.ok(Date.now()-start < 800, 'original hard deadline plus grace remains bounded');
      assert.ok(['confirmed','unknown'].includes(failure.cleanupState));
      if(mode==='unreadable'||mode==='census_limit') assert.equal(failure.cleanupState,'unknown');
      if(mode==='term_reaped') assert.equal(failure.cleanupState,'confirmed');
      if(mode==='delayed_kill') assert.equal(killDelivered,true,'rejection must wait for the observable signal effect, not only kill() return');
      if (!syncFs.existsSync(pidFile)) {
        assert.ok(attempt < 3, 'fake CLI never reached ready before the hard deadline (3 attempts)');
        continue;
      }
      const {child} = JSON.parse(await fs.readFile(pidFile,'utf8'));
      let alive = false;
      try {
        process.kill(child,0);
        const stat = await fs.readFile('/proc/'+child+'/stat','utf8');
        const state = stat.slice(stat.lastIndexOf(')')+2).split(' ')[0];
        alive = !['Z','X'].includes(state);
      } catch(error) {
        if(error.code!=='ESRCH'&&error.code!=='ENOENT') throw error;
      }
      assert.equal(alive,false,'descendant must already be physically stopped at rejection');
      results.push({mode,attempt,cleanupState:failure.cleanupState,elapsedMs:Date.now()-start,descendantAlive:alive});
      passed++;
      break;
     }
    }
    console.log(JSON.stringify({cases:results}));
    console.log(`Strict cleanup: ${passed}/${passed} real groups stopped; inaccessible/capped census stays unknown; fixed deadlines preserved`);
  } finally {
    process.kill = kill;
    syncFs.opendirSync = openDirectory;
    if(oldBin===undefined) delete process.env.CLAWMOBILE_OPENCLAW_BIN;
    else process.env.CLAWMOBILE_OPENCLAW_BIN=oldBin;
    try{const group=JSON.parse(await fs.readFile(pidFile,'utf8'));kill.call(process,-group.parent,'SIGKILL');}catch{}
    await fs.rm(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
