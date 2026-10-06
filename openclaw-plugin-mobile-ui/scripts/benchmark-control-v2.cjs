/** Explicit read-only acceptance utility. No production server, timers or source mutation is installed. */
const assert=require('node:assert/strict');
const http=require('node:http');const fs=require('node:fs');const {performance}=require('node:perf_hooks');
const {handleControl}=require('../dist/companion/control');
function request(port,path){return new Promise((resolve,reject)=>{
 const start=performance.now();const req=http.get({host:'127.0.0.1',port,path},res=>{
  const buffers=[];res.on('data',x=>buffers.push(x));res.on('end',()=>{
   const body=Buffer.concat(buffers);let value;try{value=JSON.parse(body)}catch{return reject(Error('invalid_json'))}
   const meta={status:res.statusCode,ms:+(performance.now()-start).toFixed(3),bytes:body.length};
   if(value.sections)meta.sections=Object.fromEntries(Object.entries(value.sections).map(([key,s])=>[key,{availability:s.availability,freshness:s.freshness,remainingFreshMs:s.remainingFreshMs}]));
   if(value.computation)meta.computation=value.computation;
   resolve(meta);
  });
 });req.setTimeout(10000,()=>req.destroy(Error('benchmark_timeout')));req.on('error',reject);
})}
(async()=>{
 const report={recordedAt:new Date().toISOString(),scope:'Isolated candidate HTTP handler over current read-only S24 sources; not installed runtime, not UI click-to-content',cacheEnabled:process.env.SAMANTHA_CONTROL_CACHE==='1',endpoints:[],concurrent:null};
 const server=http.createServer(async(req,res)=>{if(!await handleControl(req,res,req.url)){res.writeHead(404);res.end()}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 try {
  for(const name of ['health','requests','intelligence','automations','situations','activity']){
   const samples=[];
   for(let i=0;i<3;i++)samples.push(await request(port,'/control/'+name+'?contract=2&force=1'));
   report.endpoints.push({section:name,samples});console.log(JSON.stringify({section:name,samples}));
  }
  report.concurrent=await Promise.all([1,2,3].map(()=>request(port,'/control/health?contract=2&force=1')));
  assert.equal(new Set(report.concurrent.map(x=>x.computation.computationId)).size,1);
  if(process.env.SAMANTHA_CONTROL_EVIDENCE)fs.writeFileSync(process.env.SAMANTHA_CONTROL_EVIDENCE,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({completed:true,concurrentCollects:1}));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
