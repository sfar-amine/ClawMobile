const assert=require("node:assert/strict");
const http=require("node:http");
const {route}=require("../dist/companion/server");
(async()=>{
 const server=http.createServer((req,res)=>route(req,res).catch(e=>{res.statusCode=500;res.end(String(e.message));}));
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{
  const port=server.address().port;
  const url="http://127.0.0.1:"+port+"/v1/lighting/d073d5225b23/state";
  const mutation=await fetch(url,{method:"POST",body:"{}",headers:{"content-type":"application/json"}});
  assert.equal(mutation.status,403);
  const browser=await fetch(url,{headers:{origin:"https://example.com"}});
  assert.equal(browser.status,403);
  const invalid=await fetch(url,{method:"POST",body:JSON.stringify({device_id:"bad"}),headers:{"content-type":"application/json","x-clawmobile-owner-flow":"v1"}});
  assert.equal(invalid.status,400);
  console.log("LIFX route: missing owner, browser origin and mismatched device refused before UDP mutation.");
 }finally{await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
