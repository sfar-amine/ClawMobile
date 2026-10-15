// Actual pinned OpenClaw/Google SDK, fake in-memory transport and credential.
// Never load runtime config/auth or use the S24 token; no external network.
import test from "node:test";
import assert from "node:assert/strict";
import {createRequire,syncBuiltinESMExports} from "node:module";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import {loadPublicSynthesisOwner,synthesizePublic,MODEL,MODEL_ID,PROFILE} from "./gemini-public-synthesis.mjs";

// The harness is explicitly not permitted to inherit connector/provider secrets.
for(const key of Object.keys(process.env)) {
  if(!["PATH","HOME","TMPDIR","TEMP","TMP","SYSTEMROOT","COMSPEC","WINDIR","NODE_NO_WARNINGS"].includes(key))delete process.env[key];
}
const noNetwork=()=>{throw new Error("offline_test_network_forbidden");};
net.connect=noNetwork;net.createConnection=noNetwork;tls.connect=noNetwork;
http.request=noNetwork;http.get=noNetwork;https.request=noNetwork;https.get=noNetwork;
syncBuiltinESMExports();
let calls=[];
let mode="success";
globalThis.fetch=async(input,options={})=>{
  const url=typeof input==="string"?input:input.url;
  const body=typeof input==="object"&&input.text?await input.text():options.body;
  calls.push({url,body:JSON.parse(body)});
  assert.equal(new URL(url).origin,"https://generativelanguage.googleapis.com");
  if(mode==="quota"||mode==="unavailable")return new Response(JSON.stringify({error:{code:mode==="quota"?429:503,
    message:"offline unavailable",status:mode==="quota"?"RESOURCE_EXHAUSTED":"UNAVAILABLE"}}),
    {status:mode==="quota"?429:503,headers:{"content-type":"application/json"}});
  const claims=[{id:"c1",text:"The product is blue.",sourceIds:["s1"],support:[{sourceId:"s1",quote:"The product is blue."}]}];
  const chunk={modelVersion:mode==="wrongmodel"?"gemini-2.5-pro":MODEL_ID,
    candidates:[{content:{role:"model",parts:[{text:JSON.stringify({claims})}]},finishReason:"STOP"}],
    usageMetadata:{promptTokenCount:10,candidatesTokenCount:20,totalTokenCount:30}};
  return new Response("data: "+JSON.stringify(chunk)+"\n\n",{headers:{"content-type":"text/event-stream"}});
};
const packagePath=path.resolve(process.argv[2]);
const native=await loadPublicSynthesisOwner(createRequire(path.join(packagePath,"package.json")).resolve);
const cfg={auth:{profiles:{[PROFILE]:{provider:"google",mode:"api_key"}}},agents:{entries:{gemini:{
  model:{primary:`${MODEL}@${PROFILE}`,fallbacks:[]},modelPolicy:{allow:[MODEL]},contextInjection:"never"}}},
  privateMemory:"PRIVATE_CANARY_SHOULD_NEVER_LEAVE"};
const request={version:1,query:"Public news",responseLanguage:"en",remainingBudgetMs:2000,correlationId:"native_offline_01",
  sources:[{id:"s1",title:"Public title",url:"https://example.org/news",excerpt:"The product is blue."}]};
const owner={...native,loadConfig:()=>cfg,
  resolveApiKeyForProvider:async()=>({profileId:PROFILE,mode:"api-key",apiKey:"FAKE_OFFLINE_KEY"})};

test("native catalog and real provider serialize one public message without tool/history/memory",async()=>{
  calls=[];mode="success";
  const result=await synthesizePublic(request,owner,{env:{}});
  assert.equal(result.outcome,"complete",JSON.stringify(result));
  assert.equal(calls.length,1);
  assert.ok(!JSON.stringify(calls).includes("PRIVATE_CANARY"));
  assert.equal(calls[0].body.contents.length,1);
  assert.equal(calls[0].body.tools,undefined);
  assert.equal(calls[0].body.toolConfig,undefined);
  assert.equal(calls[0].body.cachedContent,undefined);
  assert.equal(calls[0].body.generationConfig.responseMimeType,"application/json");
  assert.equal(result.metrics.reportedCostUsd,null);
});
test("native Google 429 performs no hidden retries",async()=>{
  calls=[];mode="quota";
  const result=await synthesizePublic(request,owner,{env:{}});
  assert.equal(result.outcome,"partial");
  assert.equal(result.error.code,"quota_exhausted");
  assert.equal(calls.length,1);
});
test("native responseModel mismatch cannot hide behind requested model metadata",async()=>{
  calls=[];mode="wrongmodel";
  const result=await synthesizePublic(request,owner,{env:{}});
  assert.equal(result.error.code,"invalid_provider_response");
  assert.equal(calls.length,1);
});
test("native Google 503 cannot cause a second generation",async()=>{
  calls=[];mode="unavailable";
  const result=await synthesizePublic(request,owner,{env:{}});
  assert.equal(result.outcome,"partial");
  assert.equal(calls.length,1);
});
