// Real Linux flock and the actual stop/start owner; synthetic TCP Gateway only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),cp=require('node:child_process');
const {once}=require('node:events');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qa-deploy-restart-'));
 let wrapper,pid;
 try{
  const home=path.join(dir,'state'),lock=path.join(home,'deploys/companion-deploy.lock');fs.mkdirSync(path.dirname(lock),{recursive:true});fs.writeFileSync(lock,'',{mode:0o600});
  const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const gateway=path.join(dir,'fixture-gateway.cjs'),record=path.join(dir,'gateway.pid');
  fs.writeFileSync(gateway,`const net=require('node:net'),fs=require('node:fs');const server=net.createServer(s=>s.end());server.listen(${port},'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(record)},String(process.pid)));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  const previous=path.join(dir,'old-tier0');fs.mkdirSync(previous);fs.writeFileSync(path.join(previous,'runtime_mode.py'),'raise RuntimeError("old_release_must_not_be_used")\n');
  const owner=path.resolve(__dirname,'../../installer/termux-lite/runtime_mode.py'),entry=path.resolve(__dirname,'../dist/companion/openclawGatewayClient.js');
  const script=`import fcntl,json,os,subprocess,sys\nf=open(sys.argv[1],'r+')\nfcntl.flock(f,fcntl.LOCK_EX)\nenv={**os.environ,'SAMANTHA_DEPLOY_LOCK_FD':str(f.fileno())}\np=subprocess.run([sys.argv[2],sys.argv[3],'--deploy-restart',sys.argv[4]],env=env,pass_fds=(f.fileno(),),capture_output=True,text=True,timeout=8)\nprobe=open(sys.argv[1]);retained=False\ntry:fcntl.flock(probe,fcntl.LOCK_SH|fcntl.LOCK_NB)\nexcept BlockingIOError:retained=True\nprint(json.dumps({'exit':p.returncode,'body':p.stdout,'retained':retained}),flush=True)\nsys.stdin.buffer.read()\n`;
  wrapper=cp.spawn('python3',['-c',script,lock,process.execPath,entry,owner],{env:{...process.env,OPENCLAW_HOME:home,CLAW_RUNTIME_ROOT:previous,OPENCLAW_WORKSPACE:path.join(dir,'workspace'),CLAWMOBILE_GATEWAY_HOST:'127.0.0.1',CLAWMOBILE_GATEWAY_PORT:String(port),CLAWMOBILE_RUNTIME_START_COMMAND:process.execPath,CLAWMOBILE_RUNTIME_START_ARGS:gateway,CLAWMOBILE_RUNTIME_START_WAIT_MS:'2000'},stdio:['pipe','pipe','pipe']});
  let raw='';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture deadline')),10000);wrapper.once('error',reject);wrapper.once('exit',code=>{if(!raw.includes('\n'))reject(Error('wrapper exited '+code));});wrapper.stdout.on('data',b=>{raw+=b;if(raw.includes('\n')){clearTimeout(timer);resolve();}});});
  const result=JSON.parse(raw.trim());assert.equal(result.exit,0);assert.deepEqual(JSON.parse(result.body),{success:true});assert.equal(result.retained,true,'deployment retains EX after restart owner exits');
  pid=Number(fs.readFileSync(record,'utf8'));assert(pid>0);
  const check=cp.spawnSync('python3',['-c','import fcntl,sys;f=open(sys.argv[1]);fcntl.flock(f,fcntl.LOCK_SH|fcntl.LOCK_NB)',lock]);assert.notEqual(check.status,0);
  const closed=once(wrapper,'close');wrapper.stdin.end();await closed;wrapper=undefined;
  const free=cp.spawnSync('python3',['-c','import fcntl,sys;f=open(sys.argv[1]);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)',lock]);assert.equal(free.status,0,'new Gateway did not inherit deployment fd');
  const refused=cp.spawnSync(process.execPath,[entry,'--deploy-restart',owner],{env:{...process.env,OPENCLAW_HOME:home},encoding:'utf8',timeout:5000});assert.equal(refused.status,75);assert.deepEqual(JSON.parse(refused.stdout),{success:false});
  console.log('Deploy Gateway restart passed: actual inherited EX, actual owner restart to TCP fixture, EX retained by deploy, absent inherited authority refused; no phone effects');
 }finally{
  if(wrapper){wrapper.kill('SIGKILL');await once(wrapper,'close').catch(()=>{});}
  if(!pid){try{pid=Number(fs.readFileSync(path.join(dir,'gateway.pid'),'utf8'));}catch{}}
  if(pid){try{process.kill(pid,'SIGKILL');}catch{}}
  fs.rmSync(dir,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
