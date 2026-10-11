const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {execFileSync}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const {handleControl}=require('../dist/companion/control');
const plugin=path.resolve(__dirname,'..');
const root=path.resolve(plugin,'..');
const budget=JSON.parse(execFileSync('python3',['-c',`import importlib.util,json;from pathlib import Path;p=Path(${JSON.stringify(root)})/'installer/termux-lite/companion-acceptance.py';s=importlib.util.spec_from_file_location('acc',p);a=importlib.util.module_from_spec(s);s.loader.exec_module(a);print(json.dumps(dict(a.READS)['/control/health?contract=2']))`],{encoding:'utf8'}));
(async()=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'h8-health-'));let server;
 const prior={home:process.env.HOME,playbooks:process.env.SAMANTHA_CONTROL_PLAYBOOKS,cache:process.env.SAMANTHA_CONTROL_CACHE};
 try{
  const capture=JSON.parse(await fs.readFile(path.join(plugin,'fixtures/s24-2026-10-10/control/health.json'),'utf8'));
  const timing=await fs.readFile(path.join(plugin,'fixtures/s24-2026-10-10/control/latency.txt'),'utf8');
  const latency=Number(/health\?contract=2 200 (\d+)ms/.exec(timing)[1]);
  assert.equal(capture.sections.health.data.components.length,3);
  // Extend the captured owner projection with the new mapping row; this is
  // explicit pre-activation test data, never labelled a captured nightly run.
  capture.sections.health.data.components.push({id:'control_plane.nightly_acceptance',name:'Recette nocturne',status:'unknown',checkedAt:null});
  await fs.mkdir(path.join(temporary,'reporting'));
  await fs.writeFile(path.join(temporary,'reporting/__init__.py'),'');
  await fs.writeFile(path.join(temporary,'reporting/control_snapshot.py'),`import time\ntime.sleep(${latency/1000})\nprint(${JSON.stringify(JSON.stringify(capture))})\n`);
  await fs.mkdir(path.join(temporary,'.openclaw/health'),{recursive:true});
  const stamp=Date.now()/1000;
  await fs.writeFile(path.join(temporary,'.openclaw/health/current.json'),JSON.stringify({generated_at:stamp,overall:'healthy',capabilities:{'control_plane.nightly_acceptance':{state:'attention',checked_at:stamp-86400,reason:'nightly_acceptance_attention'}}}));
  process.env.HOME=temporary;process.env.SAMANTHA_CONTROL_PLAYBOOKS=temporary;delete process.env.SAMANTHA_CONTROL_CACHE;
  server=http.createServer(async(req,res)=>{if(!await handleControl(req,res,req.url)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const start=performance.now();const result=await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port,path:'/control/health?contract=2'},response=>{let data='';response.on('data',chunk=>data+=chunk);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(data)}));}).on('error',reject));
  const seconds=(performance.now()-start)/1000;
  assert.equal(result.status,200);assert.ok(seconds<budget,`health ${seconds}s exceeded ${budget}s`);
  const row=result.body.sections.health.data.components.find(r=>r.id==='control_plane.nightly_acceptance');
  assert.equal(row.label.fr,'Recette nocturne');assert.equal(row.status,'attention');assert.equal(row.checkedAt,new Date((stamp-86400)*1000).toISOString());assert.equal(row.description,'La recette nocturne signale une dérive de latence.');
  console.log(JSON.stringify({lot:'H8',route:'/control/health?contract=2',status:200,seconds,budget,capturedOwnerLatencyMs:latency,healthComponent:'control_plane.nightly_acceptance'}));
 }finally{
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  for(const [key,value] of [['HOME',prior.home],['SAMANTHA_CONTROL_PLAYBOOKS',prior.playbooks],['SAMANTHA_CONTROL_CACHE',prior.cache]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await fs.rm(temporary,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1});
