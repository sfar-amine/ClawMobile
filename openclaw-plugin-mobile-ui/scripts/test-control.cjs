const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const {execFileSync} = require("node:child_process");
const {handleControl} = require("../dist/companion/control");

const listeners = () => execFileSync("ps", ["-eo", "pid,args"], {encoding:"utf8"})
  .split("\n").filter(line => /python3.*claw-live\.py --control-json/.test(line)).map(line => line.trim().split(/\s+/)[0]);
const request = (port, route, options={}) => new Promise((resolve,reject) => {
  const req=http.request({host:"127.0.0.1",port,path:route,...options},res=>{
    let body="";res.on("data",data=>body+=data);res.on("end",()=>resolve({status:res.statusCode,body}));
  });req.on("error",reject);req.end();
});
async function main(){
  const before=listeners();
  const server=http.createServer(async(req,res)=>{
    if (!await handleControl(req,res,req.url)) {res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=server.address().port, evidence={tests:[],snapshotMs:null,firstEventMs:null};
  try{
    let start=Date.now();
    const snapshot=await request(port,"/control/snapshot");
    evidence.snapshotMs=Date.now()-start;
    assert.equal(snapshot.status,200);
    const value=JSON.parse(snapshot.body);
    assert.equal(value.schemaVersion,1);assert.ok(value.generatedAt);assert.ok(Array.isArray(value.recentActivity));
    evidence.tests.push("real-snapshot");
    assert.equal((await request(port,"/control/snapshot",{method:"POST"})).status,405);
    assert.equal((await request(port,"/control/snapshot",{headers:{Origin:"http://localhost"}})).status,403);
    assert.equal((await request(port,"/control/unknown")).status,404);
    evidence.tests.push("read-only","browser-origin-denied","unknown-route-denied");
    await new Promise((resolve,reject)=>{
      let closed=false;const started=Date.now();
      const req=http.get({host:"127.0.0.1",port,path:"/control/activity/stream"},res=>{
        assert.equal(res.statusCode,200);
        let body="";
        res.on("data",data=>{
          body+=data;
          if(body.includes("event: ready") && evidence.readyMs == null) evidence.readyMs=Date.now()-started;
          if(body.includes("event: activity")&&!closed){
            closed=true;evidence.firstEventMs=Date.now()-started;
            assert.notEqual(evidence.readyMs,undefined);
            assert.ok(body.includes('"source":"claw-live"'));
            res.destroy();req.destroy();clearTimeout(timeout);resolve();
          }
        });
        res.on("error",error=>{if(!closed)reject(error)});
      });
      req.on("error",error=>{if(!closed)reject(error)});
      const timeout=setTimeout(()=>{req.destroy();reject(Error("No live event within test deadline"))},20000);
    });
    evidence.tests.push("live-ready","real-live-event");
    await new Promise(resolve=>setTimeout(resolve,3000));
    assert.deepEqual(listeners(),before);
    evidence.tests.push("stream-process-closed");
    console.log(JSON.stringify(evidence));
    if(process.env.SAMANTHA_CONTROL_EVIDENCE)fs.writeFileSync(process.env.SAMANTHA_CONTROL_EVIDENCE,JSON.stringify(evidence,null,2)+"\n");
  }finally{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
