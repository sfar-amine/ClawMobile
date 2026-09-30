import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

const OPENCLAW_DIST = "/data/data/com.termux/files/usr/lib/node_modules/openclaw/dist";
export const CLAW_LIVE_MODEL = "gemini-3.8-live";
const TOKEN_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

async function resolveGeminiApiKey(): Promise<string> {
  const names = fs.readdirSync(OPENCLAW_DIST)
    .filter((name) => /^secret-store-.*\.mjs$/.test(name))
    .sort();
  for (const name of names) {
    try {
      const mod: any = await import(pathToFileURL(path.join(OPENCLAW_DIST, name)).href);
      if (typeof mod.c !== "function") continue;
      const result = mod.c({ name: "GEMINI_API_KEY", scope: { kind: "team", id: "" } });
      if (result?.ok === true && typeof result.value === "string" && result.value) {
        return result.value;
      }
    } catch {}
  }
  throw new Error("gemini_api_key_unavailable");
}

export async function createClawLiveToken(
  fetchImpl: typeof fetch = fetch,
  keyResolver: () => Promise<string> = resolveGeminiApiKey,
) {
  const key = await keyResolver();
  const now = Date.now();
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
    }),
  });
  const value: any = await response.json().catch(() => ({}));
  if (!response.ok || typeof value?.name !== "string" || !value.name) {
    throw new Error(`gemini_live_token_failed:${response.status}`);
  }
  return {
    token: value.name,
    model: CLAW_LIVE_MODEL,
    expiresAt: value.expireTime || new Date(now + 30 * 60_000).toISOString(),
    newSessionExpiresAt: value.newSessionExpireTime || new Date(now + 60_000).toISOString(),
  };
}

export function clawLivePageHtml() {
  return String.raw`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Claw Live</title>
<style>
:root{font-family:system-ui,-apple-system,sans-serif;color-scheme:dark}
body{margin:0;background:#111;color:#eee;display:grid;min-height:100vh;place-items:center}
main{width:min(720px,92vw);padding:24px}
h1{font-size:2rem;margin:0 0 8px}.muted{opacity:.7}
button{font:inherit;padding:14px 22px;border-radius:14px;border:0;margin:8px 8px 8px 0}
#start{background:#fff;color:#111}#stop{background:#333;color:#fff}
#status{margin:16px 0;padding:12px;border-radius:12px;background:#1c1c1c}
pre{white-space:pre-wrap;background:#1c1c1c;padding:14px;border-radius:12px;min-height:80px}
</style>
</head>
<body><main>
<h1>Claw Live</h1>
<div class="muted">Gemini Live + Capability Graph</div>
<div><button id="start">Démarrer</button><button id="stop" disabled>Arrêter</button></div>
<div id="status">Prêt.</div>
<pre id="transcript"></pre>
<script>
const MODEL="gemini-3.8-live";
const TOOL="clawmobile_capability";
const statusEl=document.getElementById("status");
const transcriptEl=document.getElementById("transcript");
const startBtn=document.getElementById("start");
const stopBtn=document.getElementById("stop");
let ws=null,ctx=null,stream=null,processor=null,inputSource=null,zeroGain=null;
let playing=[],playCursor=0,started=false;
function setStatus(s){statusEl.textContent=s}
function append(s){if(!s)return;transcriptEl.textContent+=(transcriptEl.textContent?"\n":"")+s}
function b64(bytes){let s="";for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(s)}
function fromB64(s){const raw=atob(s),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out}
function resample16k(float32,rate){
  if(rate===16000){const out=new Int16Array(float32.length);for(let i=0;i<float32.length;i++)out[i]=Math.max(-32768,Math.min(32767,Math.round(float32[i]*32767)));return out}
  const n=Math.max(1,Math.round(float32.length*16000/rate)),out=new Int16Array(n);
  for(let i=0;i<n;i++){const pos=i*rate/16000,lo=Math.floor(pos),hi=Math.min(float32.length-1,lo+1),f=pos-lo;const v=float32[lo]*(1-f)+float32[hi]*f;out[i]=Math.max(-32768,Math.min(32767,Math.round(v*32767)))}
  return out
}
function stopPlayback(){for(const s of playing){try{s.stop()}catch{}}playing=[];playCursor=ctx?ctx.currentTime:0}
function playPcm24(data){
  if(!ctx)return;const bytes=fromB64(data);const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const count=Math.floor(bytes.byteLength/2),buf=ctx.createBuffer(1,count,24000),ch=buf.getChannelData(0);
  for(let i=0;i<count;i++)ch[i]=view.getInt16(i*2,true)/32768;
  const src=ctx.createBufferSource();src.buffer=buf;src.connect(ctx.destination);
  const when=Math.max(ctx.currentTime+0.02,playCursor);src.start(when);playCursor=when+buf.duration;playing.push(src);
  src.onended=()=>{playing=playing.filter(x=>x!==src)};
}
async function tool(request){
  const r=await fetch("/v1/extensions/claw-live/capability",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({request})});
  const v=await r.json();if(!r.ok)throw new Error(v?.message||"capability_failed");return v;
}
function setupMessage(){
 return {setup:{
  model:"models/"+MODEL,
  generationConfig:{responseModalities:["AUDIO"]},
  sessionResumption:{},
  inputAudioTranscription:{},outputAudioTranscription:{},
  systemInstruction:{parts:[{text:[
   "You are Samantha in Claw Live.",
   "Use concise natural French unless the user asks otherwise.",
   "A capability belongs to Claw, not to a provider.",
   "For personal state, device actions, telecom, contacts, calendar, messaging, automation or any request Claw may execute, call clawmobile_capability.",
   "When calling clawmobile_capability, pass the user's request verbatim whenever possible; do not generalize or drop qualifiers.",
   "Treat execution.state=completed with execution.result.ok=true as authoritative and answer from that result.",
   "If execution.state=needs_clarification, ask only for one returned choice and do not suggest external apps.",
   "Do not claim a Claw action is impossible before using the tool.",
   "Respect confirmation_required and never invent successful execution."
  ].join(" ")}]},
  tools:[{functionDeclarations:[{
   name:TOOL,description:"Resolve and execute the shortest healthy reachable Claw capability route for the owner request.",behavior:"BLOCKING",
   parameters:{type:"OBJECT",properties:{request:{type:"STRING"}},required:["request"]}
  }]}]
 }};
}
async function startMic(){
 ctx=new AudioContext({latencyHint:"interactive"});await ctx.resume();
 stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
 inputSource=ctx.createMediaStreamSource(stream);processor=ctx.createScriptProcessor(2048,1,1);zeroGain=ctx.createGain();zeroGain.gain.value=0;
 processor.onaudioprocess=(e)=>{if(!ws||ws.readyState!==WebSocket.OPEN||!started)return;const pcm=resample16k(e.inputBuffer.getChannelData(0),ctx.sampleRate);ws.send(JSON.stringify({realtimeInput:{audio:{data:b64(new Uint8Array(pcm.buffer)),mimeType:"audio/pcm;rate=16000"}}}))};
 inputSource.connect(processor);processor.connect(zeroGain);zeroGain.connect(ctx.destination);
 started=true;setStatus("Écoute…");startBtn.disabled=true;stopBtn.disabled=false;
}
async function start(){
 try{
  setStatus("Autorisation…");transcriptEl.textContent="";
  const tokenResp=await fetch("/v1/extensions/claw-live/token",{method:"POST"});
  const token=await tokenResp.json();if(!tokenResp.ok)throw new Error(token?.message||"token_failed");
  const url="wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token="+encodeURIComponent(token.token);
  ws=new WebSocket(url);
  ws.onopen=()=>{setStatus("Connexion Gemini…");ws.send(JSON.stringify(setupMessage()))};
  ws.onerror=()=>setStatus("Erreur de connexion.");
  ws.onclose=()=>{if(started)setStatus("Session fermée.");cleanup(false)};
  ws.onmessage=async(ev)=>{
   const m=JSON.parse(typeof ev.data==="string"?ev.data:await ev.data.text());
   if(m.setupComplete!==undefined){await startMic();return}
   if(m.toolCall?.functionCalls){
    const results=[];
    for(const fc of m.toolCall.functionCalls){
     if(fc.name!==TOOL){results.push({error:"unsupported_tool"});continue}
     try{results.push(await tool(String(fc.args?.request||"")))}catch(e){results.push({error:String(e?.message||e)})}
    }
    ws.send(JSON.stringify({toolResponse:{functionResponses:m.toolCall.functionCalls.map((fc,i)=>({name:fc.name,id:fc.id,response:{result:results[i]}}))}}));
   }
   const sc=m.serverContent;
   if(sc?.interrupted)stopPlayback();
   if(sc?.inputTranscription?.text)append("Vous : "+sc.inputTranscription.text.trim());
   if(sc?.outputTranscription?.text)append("Samantha : "+sc.outputTranscription.text.trim());
   for(const part of sc?.modelTurn?.parts||[])if(part.inlineData?.data&&String(part.inlineData.mimeType||"").startsWith("audio/"))playPcm24(part.inlineData.data);
  };
 }catch(e){setStatus("Erreur : "+String(e?.message||e));cleanup(true)}
}
function cleanup(closeSocket=true){
 started=false;
 if(processor){try{processor.disconnect()}catch{}processor=null}
 if(inputSource){try{inputSource.disconnect()}catch{}inputSource=null}
 if(zeroGain){try{zeroGain.disconnect()}catch{}zeroGain=null}
 if(stream){for(const t of stream.getTracks())t.stop();stream=null}
 stopPlayback();
 if(closeSocket&&ws){try{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({realtimeInput:{audioStreamEnd:true}}));ws.close()}catch{}}
 ws=null;startBtn.disabled=false;stopBtn.disabled=true;
}
startBtn.onclick=start;
stopBtn.onclick=()=>{setStatus("Arrêt…");cleanup(true);setStatus("Prêt.")};
window.addEventListener("beforeunload",()=>cleanup(true));
</script></main></body></html>`;
}
