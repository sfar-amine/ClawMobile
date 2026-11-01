// S24 01/11: the OpenClaw 2026.10.9 Gateway started by openclaw-upgrade (ppid 1, no Companion pidfile, the
// pidfile still naming the stopped 9.6 Gateway) was never signalled by --deploy-restart, so every deploy and its
// rollback failed with gateway_restart_failed. Real S24 rows (fixtures/s24-2026-11-01-deploy-restart-1009), real
// Linux flock, the actual stop/start owner; synthetic TCP Gateways only. No phone effect.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),cp=require('node:child_process');
const {once}=require('node:events');
const capture=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../fixtures/s24-2026-11-01-deploy-restart-1009/capture.json'),'utf8'));
const gateway=require('../dist/companion/openclawGatewayClient.js');

function pureSelection(){
  const rows=gateway.parseProcessTable([capture.gateway.ps_ef_row,...capture.gateway.children_ps_ef_rows,capture.gateway.cli_short_lived_ps_ef_row].join('\n'));
  const candidates=rows.filter(row=>gateway.isGatewayRuntimeCommand(row.command));
  assert.deepEqual(candidates.map(row=>[row.pid,row.ppid]),[[22573,1]],'the 2026.10.9 title is a Gateway candidate; workers and CLI are not');
  // The incident, replayed: pidfile 26995 (stopped 9.6 Gateway), caller neither parent nor recorded.
  assert.deepEqual(gateway.selectGatewayStopTargets(candidates,capture.companion_pidfile.content.trim()*1,new Set(),19373),[],'pre-fix selection');
  const own='/state/.openclaw';
  const byState=gateway.selectAdoptableGateways(candidates,{leasePid:null,ownStateDir:own,stateDirOf:pid=>pid===22573?own:null});
  assert.deepEqual([...byState],[22573],'adopted by its state directory');
  const lease=capture.state_leases.gateway_owner_row.payload_json.owner.pid;
  const byLease=gateway.selectAdoptableGateways(candidates,{leasePid:lease,ownStateDir:own,stateDirOf:()=>null});
  assert.deepEqual([...byLease],[22573],'adopted by the OpenClaw gateway-owner lease');
  const foreign=gateway.selectAdoptableGateways(candidates,{leasePid:null,ownStateDir:own,stateDirOf:()=>'/preprod/state'});
  assert.equal(foreign.size,0,'a Gateway of another state directory is never adopted');
  assert.deepEqual(gateway.selectGatewayStopTargets(candidates,26995,byState,19373).map(row=>row.pid),[22573]);
  assert.deepEqual(gateway.descendantPids(rows,new Set([22573])).sort(),[22931,23598,25720],'spawn-broker workers and their sqlite reader');
  assert.equal(gateway.isGatewayServiceCommand(capture.gateway.ps_ef_row),true);
  for(const command of ['/data/data/com.termux/files/usr/bin/bash /x/termux-lite/gateway-start.sh','node /usr/lib/node_modules/openclaw/openclaw.mjs gateway status','node /usr/lib/node_modules/openclaw/openclaw.mjs channels status'])
    assert.equal(gateway.isGatewayServiceCommand(command),false,command);
  assert.equal(gateway.isGatewayServiceCommand('node /usr/lib/node_modules/openclaw/openclaw.mjs gateway --bind loopback --port 18789 --verbose'),true);
}

function startedAt(pid){const t=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return Number(t.slice(t.lastIndexOf(')')+2).split(' ')[19]);}
// A zombie awaiting a non-reaping init (containers) has terminated.
function alive(pid){try{process.kill(pid,0);}catch{return false;}try{const t=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return !t.slice(t.lastIndexOf(')')+2).startsWith('Z');}catch{return false;}}
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function waitFor(fn,ms,label){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error(label);}
function reachable(port){return new Promise(r=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();r(true);});s.once('error',()=>r(false));});}

(async()=>{
 pureSelection();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-adopt-'));
 const pids=[];let wrapper;
 try{
  const state=path.join(dir,'state'),lock=path.join(state,'deploys/companion-deploy.lock'),workspace=path.join(dir,'workspace');
  fs.mkdirSync(path.dirname(lock),{recursive:true});fs.writeFileSync(lock,'',{mode:0o600});
  fs.mkdirSync(path.join(workspace,'logs'),{recursive:true});
  const dead=cp.spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'}).stdout.trim();
  fs.writeFileSync(path.join(workspace,'logs/companion-openclaw-gateway.pid'),dead+'\n');
  const port=await freePort(),decoyPort=await freePort();
  // A foreign 2026.10.9-like Gateway: title openclaw-gateway, slow graceful shutdown (2 s, beyond the former
  // 750 ms SIGKILL), one worker it leaves behind as the spawn-broker workers would be after a SIGKILL.
  const fixture=path.join(dir,'foreign-gateway.cjs');
  fs.writeFileSync(fixture,`process.title='openclaw-gateway';const net=require('node:net'),fs=require('node:fs'),cp=require('node:child_process');
const [port,record]=process.argv.slice(2);const worker=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
const server=net.createServer(s=>s.end());server.listen(Number(port),'127.0.0.1',()=>fs.writeFileSync(record,JSON.stringify({pid:process.pid,worker:worker.pid})));
process.on('SIGTERM',()=>setTimeout(()=>server.close(()=>{fs.writeFileSync(record+'.graceful','1');process.exit(0);}),2000));`);
  const spawnGateway=(listen,record,stateDir)=>{const child=cp.spawn(process.execPath,[fixture,String(listen),record],{detached:true,stdio:'ignore',env:{...process.env,OPENCLAW_STATE_DIR:stateDir}});child.unref();return child;};
  const foreignRecord=path.join(dir,'foreign.json'),decoyRecord=path.join(dir,'decoy.json');
  spawnGateway(port,foreignRecord,state);
  spawnGateway(decoyPort,decoyRecord,path.join(dir,'preprod-state'));
  await waitFor(()=>fs.existsSync(foreignRecord)&&fs.existsSync(decoyRecord),5000,'fixtures did not listen');
  const foreign=JSON.parse(fs.readFileSync(foreignRecord,'utf8')),decoy=JSON.parse(fs.readFileSync(decoyRecord,'utf8'));
  pids.push(foreign.pid,foreign.worker,decoy.pid,decoy.worker);
  assert.match(fs.readFileSync(`/proc/${foreign.pid}/cmdline`,'utf8'),/openclaw-gateway/,'fixture carries the 2026.10.9 title');
  // OpenClaw's own lease, S24 schema and payload, naming the foreign Gateway with its start time.
  const lease=JSON.parse(JSON.stringify(capture.state_leases.gateway_owner_row));
  lease.payload_json.owner.pid=foreign.pid;lease.payload_json.owner.startedAt=startedAt(foreign.pid);lease.payload_json.port=port;
  fs.mkdirSync(path.join(state,'state'),{recursive:true});
  const seeded=cp.spawnSync('python3',['-c','import json,sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute(sys.argv[2]);r=json.loads(sys.argv[3]);c.execute("insert into state_leases values (?,?,?,?,?,?,?,?)",(r["scope"],r["lease_key"],r["owner"],r["expires_at"],r["heartbeat_at"],json.dumps(r["payload_json"]),r["created_at"],r["updated_at"]));c.commit()',
    path.join(state,'state/openclaw.sqlite'),capture.state_leases.sql,JSON.stringify(lease)],{encoding:'utf8'});
  assert.equal(seeded.status,0,seeded.stderr);
  const owner=path.resolve(__dirname,'../../installer/termux-lite/runtime_mode.py');
  const leaseRead=cp.spawnSync('python3',[owner,'--gateway-owner-pid',state],{encoding:'utf8'});
  assert.deepEqual(JSON.parse(leaseRead.stdout),{pid:foreign.pid},'lease helper names the foreign Gateway');

  const next=path.join(dir,'next-gateway.cjs'),nextRecord=path.join(dir,'next.json');
  fs.writeFileSync(next,`const net=require('node:net'),fs=require('node:fs');const server=net.createServer(s=>s.end());server.listen(${port},'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(nextRecord)},String(process.pid)));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  const entry=path.resolve(__dirname,'../dist/companion/openclawGatewayClient.js');
  const preload=path.join(dir,'catalog-owner.cjs');
  fs.writeFileSync(preload,`const Module=require('node:module');const p=${JSON.stringify(path.resolve(__dirname,'../dist/companion/openclawAgentClient.js'))};const m=new Module(p);m.filename=p;m.loaded=true;m.exports={callOpenClawGateway:async()=>({agentId:'main',groups:[{tools:[{name:'t'}]}]}),closeOpenClawGateway:()=>{}};require.cache[p]=m;`);
  const script=`import fcntl,json,os,subprocess,sys\nf=open(sys.argv[1],'r+')\nfcntl.flock(f,fcntl.LOCK_EX)\nenv={**os.environ,'SAMANTHA_DEPLOY_LOCK_FD':str(f.fileno())}\np=subprocess.run([sys.argv[2],'--require',sys.argv[5],sys.argv[3],'--deploy-restart',sys.argv[4]],env=env,pass_fds=(f.fileno(),),capture_output=True,text=True,timeout=40)\nprint(json.dumps({'exit':p.returncode,'body':p.stdout,'diagnostic':p.stderr}),flush=True)\n`;
  const started=Date.now();
  wrapper=cp.spawn('python3',['-c',script,lock,process.execPath,entry,owner,preload],{env:{...process.env,OPENCLAW_HOME:state,OPENCLAW_STATE_DIR:state,OPENCLAW_WORKSPACE:workspace,CLAWMOBILE_GATEWAY_HOST:'127.0.0.1',CLAWMOBILE_GATEWAY_PORT:String(port),CLAWMOBILE_RUNTIME_START_COMMAND:process.execPath,CLAWMOBILE_RUNTIME_START_ARGS:next,CLAWMOBILE_RUNTIME_START_WAIT_MS:'5000'},stdio:['ignore','pipe','pipe']});
  let raw='';wrapper.stdout.on('data',b=>{raw+=b;});await once(wrapper,'close');wrapper=undefined;
  const result=JSON.parse(raw.trim());
  const lines=result.diagnostic.trim().split('\n').map(line=>JSON.parse(line));
  const verdict=lines.find(line=>line.component==='runtime-restart');
  assert.equal(result.exit,0,result.diagnostic);assert.deepEqual(JSON.parse(result.body),{success:true});
  assert.equal(verdict.success,true);assert.match(verdict.message,/Targets: 1 \(adopted 1\); descendants stopped: 1\./);
  assert(!/OPENCLAW_|SAMANTHA_DEPLOY_LOCK_FD|preprod-state/.test(result.diagnostic),'no environment value in the deploy log');
  assert.equal(fs.existsSync(foreignRecord+'.graceful'),true,'foreign Gateway stopped gracefully, not SIGKILLed at 750 ms');
  assert.equal(alive(foreign.pid),false);assert.equal(alive(foreign.worker),false,'worker left by the Gateway is stopped');
  assert.equal(alive(decoy.pid),true,'preprod Gateway (other state directory) untouched');assert.equal(await reachable(decoyPort),true);
  const restarted=Number(fs.readFileSync(nextRecord,'utf8'));pids.push(restarted);
  assert.equal(Number(fs.readFileSync(path.join(workspace,'logs/companion-openclaw-gateway.pid'),'utf8')),restarted,'pidfile now names the Gateway it launched');
  assert(Date.now()-started<30000,'bounded restart');

  console.log(`Gateway adoption restart passed in ${Date.now()-started} ms: S24 2026.10.9 rows replayed (0 targets before the fix), foreign Gateway adopted by state directory and OpenClaw lease, graceful stop beyond 750 ms, orphan worker stopped, preprod Gateway untouched, pidfile rewritten, real inherited EX; no phone effects`);
 }finally{
  if(wrapper){wrapper.kill('SIGKILL');await once(wrapper,'close').catch(()=>{});}
  for(const pid of pids){try{process.kill(pid,'SIGKILL');}catch{}}
  fs.rmSync(dir,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
