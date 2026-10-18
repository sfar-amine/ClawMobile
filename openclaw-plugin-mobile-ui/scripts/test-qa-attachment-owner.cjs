const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {qaAttachmentOwner,allowlistOwner}=require('../dist/companion/whatsappAllowlist');
const runtime=require('../dist/runtimeRoot');
let checks=0;const check=fn=>{fn();checks++;};
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'qa-attachment-ipc-'));
 const helper=path.join(root,'people.py'),record=path.join(root,'record.json'),effect=path.join(root,'unexpected-effect');
 await fs.writeFile(helper,`import sys,json,os,time,subprocess,hashlib
mode=sys.argv[1]
if mode=='qa-attachment-consume':
 header=json.loads(sys.stdin.buffer.readline(16386));content=sys.stdin.buffer.read()
 data={'argv':sys.argv[1:],'header':header,'size':len(content),'sha256':hashlib.sha256(content).hexdigest()}
else:
 data={'argv':sys.argv[1:],'header':json.load(sys.stdin)}
with open(os.environ['QA_TEST_RECORD'],'w') as f:json.dump(data,f)
scenario=os.environ.get('QA_TEST_SCENARIO','')
if scenario=='sleep':
 subprocess.Popen([sys.executable,'-c','import time,pathlib;time.sleep(.5);pathlib.Path('+repr(os.environ['QA_TEST_EFFECT'])+').write_text("should never happen")'])
 time.sleep(10)
if scenario=='stderr':sys.stderr.write('PRIVATE_DIAGNOSTIC_NEVER_RETURN');sys.exit(1)
if scenario=='large':sys.stdout.write('x'*32769);sys.exit(0)
if scenario=='bad':print(json.dumps({'state':'invented'}));sys.exit(0)
if mode=='allowlist':result={'success':True,'state':'listed'}
elif mode=='qa-attachment-admit':result={'ok':True,'admission':{'synthetic_label':'équipe'}}
else:result={'state':'imported'}
encoded=json.dumps(result,ensure_ascii=False).encode('utf-8')
for byte in encoded:os.write(1,bytes([byte]))
`);
 const saved={helper:process.env.SAMANTHA_PEOPLE_TRUSTED,scenario:process.env.QA_TEST_SCENARIO};
 process.env.SAMANTHA_PEOPLE_TRUSTED=helper;process.env.QA_TEST_RECORD=record;process.env.QA_TEST_EFFECT=effect;
 const signal=()=>new AbortController().signal;
 const context={synthetic:'fixture-never-argv'};
 try {
  let r=await qaAttachmentOwner('admit',{context},{signal:signal(),remaining_ms:1000});
  check(()=>assert.equal(r.ok,true));check(()=>assert.equal(r.admission.synthetic_label,'équipe'));
  let captured=JSON.parse(await fs.readFile(record));check(()=>assert.deepEqual(captured.argv,['qa-attachment-admit']));
  check(()=>assert.deepEqual(captured.header,{context}));
  const content=Buffer.alloc(20*1024*1024,7),metadata={size_bytes:content.length};
  r=await qaAttachmentOwner('consume',{admission:{context},metadata},{signal:signal(),remaining_ms:2000,content});
  check(()=>assert.deepEqual(r,{state:'imported'}));captured=JSON.parse(await fs.readFile(record));
  check(()=>assert.deepEqual(captured.argv,['qa-attachment-consume']));check(()=>assert.equal(captured.size,20*1024*1024));
  check(()=>assert.equal(captured.sha256,require('node:crypto').createHash('sha256').update(content).digest('hex')));
  const before=await fs.readFile(record,'utf8');
  for(const [mode,body,opts] of [
   ['consume',{admission:{},metadata:{}},{content:Buffer.alloc(20*1024*1024+1)}],
   ['admit',{context,extra:'forbidden'},{}],['admit',{context:{large:'x'.repeat(16384)}},{}],
   ['admit',{context},{remaining_ms:10001}],['consume',{admission:{},metadata:{}},{}]]){
   r=await qaAttachmentOwner(mode,body,{signal:signal(),remaining_ms:1000,...opts});
   check(()=>assert.equal(mode==='admit'?r.ok:r.state,mode==='admit'?false:'blocked'));
   const unchanged=await fs.readFile(record,'utf8');check(()=>assert.equal(unchanged,before));
  }
  const cancelled=new AbortController();cancelled.abort();
  r=await qaAttachmentOwner('consume',{admission:{},metadata:{}},{signal:cancelled.signal,remaining_ms:1000,content:Buffer.from('x')});
  check(()=>assert.equal(r.state,'blocked'));
  for(const scenario of ['stderr','bad','large']){
   process.env.QA_TEST_SCENARIO=scenario;
   r=await qaAttachmentOwner('consume',{admission:{},metadata:{}},{signal:signal(),remaining_ms:1000,content:Buffer.from('x')});
   check(()=>assert.equal(r.state,'unknown'));check(()=>assert(!JSON.stringify(r).includes('PRIVATE_DIAGNOSTIC')));
  }
  process.env.QA_TEST_SCENARIO='sleep';
  const abort=new AbortController();setTimeout(()=>abort.abort(),100);
  r=await qaAttachmentOwner('consume',{admission:{},metadata:{}},{signal:abort.signal,remaining_ms:1000,content:Buffer.from('x')});
  check(()=>assert.equal(r.state,'unknown'));
  await new Promise(resolve=>setTimeout(resolve,650));
  await assert.rejects(fs.stat(effect),e=>e.code==='ENOENT');checks++;
  process.env.QA_TEST_SCENARIO='sleep';
  const started=Date.now();
  await assert.rejects(allowlistOwner('qa-ingress-read',{requester_hash:'wa-fixture'},false,true,{signal:signal(),remaining_ms:80}));checks++;
  check(()=>assert(Date.now()-started<500));
  await new Promise(resolve=>setTimeout(resolve,650));
  await assert.rejects(fs.stat(effect),e=>e.code==='ENOENT');checks++;
  await assert.rejects(allowlistOwner('list',{},false,false,{signal:signal(),remaining_ms:100}));checks++;
  process.env.QA_TEST_SCENARIO='';
  delete process.env.SAMANTHA_PEOPLE_TRUSTED;
  const original=runtime.runtimeFile;let calls=0;
  runtime.runtimeFile=name=>{assert.equal(name,'people-trusted.py');calls++;return helper;};
  try{const standard=await allowlistOwner('list',{synthetic:'fixture-never-argv'});check(()=>assert.deepEqual(standard,{success:true,state:'listed'}));}finally{runtime.runtimeFile=original;}
  check(()=>assert.equal(calls,1));
  captured=JSON.parse(await fs.readFile(record));check(()=>assert.deepEqual(captured.argv,['allowlist','list']));
  console.log(`${checks}/${checks} attachment IPC checks passed; raw stdin, bounded replies, abort kills group, F1 root, no S24 effects`);
 }finally{
  if(saved.helper===undefined)delete process.env.SAMANTHA_PEOPLE_TRUSTED;else process.env.SAMANTHA_PEOPLE_TRUSTED=saved.helper;
  if(saved.scenario===undefined)delete process.env.QA_TEST_SCENARIO;else process.env.QA_TEST_SCENARIO=saved.scenario;
  delete process.env.QA_TEST_RECORD;delete process.env.QA_TEST_EFFECT;
 }
 await fs.rm(root,{recursive:true,force:true});
})().catch(error=>{console.error(error);process.exitCode=1;});
