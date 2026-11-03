// S24 02/11: every Gateway start truncated ~/.openclaw/workspace/logs/companion-openclaw-gateway.log
// (fs.writeFileSync, flag "w"), so each deploy restart erased the previous run (16:13–19:24 UTC lost at the 19:24
// UTC restart; 08:01–16:13 UTC and 01/11 10:55–23:19 UTC the same way). Real S24 metadata and log head
// (fixtures/s24-2026-11-02-gateway-log-truncation), the actual startRuntime owner, a synthetic TCP Gateway, and the
// existing bounded rotation (gateway-log-retention.py). No phone effect.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),cp=require('node:child_process');
const {once}=require('node:events');
const capture=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../fixtures/s24-2026-11-02-gateway-log-truncation/capture.json'),'utf8'));
const HEADER=/^--- OpenClaw gateway start \d{4}-\d{2}-\d{2}T[\d:.]+Z ---$/;

function fixtureProvesTruncation(){
  const active=capture.files[0];
  assert.match(active.first_line,HEADER,'S24: the active log starts with the start header');
  assert.equal(capture.start_header_count[active.name],1);
  // The restart at 20:22 local is 19:2x UTC: the header time is the restart, nothing earlier survived.
  const restart=Date.parse(capture.restarts_local.at(-1).at),header=Date.parse(active.first_line.slice(27,-4));
  assert(header-restart>0&&header-restart<10*60_000,'header written by the 20:22 deploy restart');
  for(const archive of capture.files.slice(1)){assert.equal(archive.size,4*1024*1024);assert.equal(archive.mode,'0600');}
  // Each missing range ends where a restart or a rotation began a new file.
  assert.equal(capture.missing_ranges_utc.length,3);
  assert.equal(capture.files[1].first_ts_utc.slice(0,16),'2026-11-01T23:19');
  assert(Date.parse(capture.files[1].first_ts_utc)-Date.parse(capture.restarts_local[0].at)<5*60_000,'log.1 begins just after the 00:17 local restart');
}

function sourceNeverTruncates(){
  const source=fs.readFileSync(path.resolve(__dirname,'../src/companion/openclawGatewayClient.ts'),'utf8');
  assert(!/writeFileSync\(\s*logPath/.test(source),'no writeFileSync on the Gateway log');
  assert(!/openSync\(\s*logPath\s*,\s*["']w/.test(source),'no "w" open of the Gateway log');
  assert.match(source,/out = openGatewayLogForAppend\(logPath\);/);
}

async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function waitFor(fn,ms,label){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error(label);}
function reachable(port){return new Promise(r=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();r(true);});s.once('error',()=>r(false));});}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}

(async()=>{
 fixtureProvesTruncation();sourceNeverTruncates();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-log-append-'));const pids=[];
 const started=Date.now();
 try{
  const home=path.join(dir,'home'),state=path.join(home,'.openclaw'),workspace=path.join(state,'workspace'),logs=path.join(workspace,'logs');
  fs.mkdirSync(logs,{recursive:true});
  const log=path.join(logs,'companion-openclaw-gateway.log');
  // The previous run as the S24 wrote it (real head), then one more line the old Gateway appended.
  const previous=capture.active_log_head.join('\n')+'\n[gateway] previous run, last line before the deploy restart\n';
  fs.writeFileSync(log,previous,{mode:0o600});
  const inode=fs.statSync(log).ino;
  const port=await freePort();
  const fake=path.join(dir,'fake-gateway.cjs');
  fs.writeFileSync(fake,`const net=require('node:net');const server=net.createServer(s=>s.end());
server.listen(${port},'127.0.0.1',()=>console.log('[gateway] fake run pid='+process.pid));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  Object.assign(process.env,{HOME:home,OPENCLAW_HOME:state,OPENCLAW_STATE_DIR:state,OPENCLAW_WORKSPACE:workspace,
    CLAWMOBILE_GATEWAY_HOST:'127.0.0.1',CLAWMOBILE_GATEWAY_PORT:String(port),CLAWMOBILE_RUNTIME_START_COMMAND:process.execPath,
    CLAWMOBILE_RUNTIME_START_ARGS:fake,CLAWMOBILE_RUNTIME_START_WAIT_MS:'8000'});
  const gateway=require('../dist/companion/openclawGatewayClient.js');
  const pidfile=path.join(logs,'companion-openclaw-gateway.pid');
  for(const round of [1,2]){
   const result=await gateway.startRuntime();
   assert.equal(result.success,true,result.message);
   const pid=Number(fs.readFileSync(pidfile,'utf8'));pids.push(pid);
   await waitFor(()=>fs.readFileSync(log,'utf8').includes(`fake run pid=${pid}`),5000,'child output not appended');
   const text=fs.readFileSync(log,'utf8');
   assert(text.startsWith(previous),`round ${round}: the previous run is kept byte for byte`);
   assert.equal(text.split('\n').filter(line=>HEADER.test(line)).length,round+1,'one start header per start, appended');
   const stat=fs.statSync(log);assert.equal(stat.ino,inode,'same inode (rotation owner relies on it)');assert.equal(stat.mode&0o777,0o600);
   process.kill(pid,'SIGTERM');await waitFor(async()=>!alive(pid)&&!(await reachable(port)),5000,'fake Gateway did not stop');
  }
  // The bound stays the existing health-cycle rotation: cap and archive count hold on the appended log, and the
  // next Gateway keeps appending to the same inode.
  fs.appendFileSync(log,'x'.repeat(200)+'\n');
  const rotate=cp.spawnSync('python3',['-c',`import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('r',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
for _ in range(5):
 print(json.dumps(m.rotate_gateway_log(Path(sys.argv[2]),max_bytes=256)))
 open(sys.argv[3],'a').write('y'*300+'\\n')`,path.resolve(__dirname,'../../installer/termux-lite/gateway-log-retention.py'),home,log],{encoding:'utf8'});
  assert.equal(rotate.status,0,rotate.stderr);
  const archives=fs.readdirSync(logs).filter(name=>/^companion-openclaw-gateway\.log\.\d+$/.test(name)).sort();
  assert.deepEqual(archives,['companion-openclaw-gateway.log.1','companion-openclaw-gateway.log.2','companion-openclaw-gateway.log.3'],'N=3 archives kept');
  for(const name of archives){const st=fs.statSync(path.join(logs,name));assert(st.size<=256,'size cap');assert.equal(st.mode&0o777,0o600);}
  assert.equal(fs.statSync(log).ino,inode,'rotation keeps the active inode');
  const result=await gateway.startRuntime();assert.equal(result.success,true,result.message);
  const pid=Number(fs.readFileSync(pidfile,'utf8'));pids.push(pid);
  await waitFor(()=>fs.readFileSync(log,'utf8').includes(`fake run pid=${pid}`),5000,'child output not appended after rotation');
  assert.match(fs.readFileSync(log,'utf8'),/^y{300}\n--- OpenClaw gateway start /,'start after rotation appends to the rotated log');
  assert(Date.now()-started<30000,'bounded');
  console.log(`Gateway log append passed in ${Date.now()-started} ms: S24 02/11 truncation replayed from the real head, 3 starts keep every earlier run on the same 0600 inode, bounded rotation (3 archives, size cap) still owns the bound; no phone effects`);
 }finally{
  for(const pid of pids){try{process.kill(pid,'SIGKILL');}catch{}}
  fs.rmSync(dir,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
