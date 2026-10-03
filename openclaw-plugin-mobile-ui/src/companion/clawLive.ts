import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
export const CLAW_LIVE_MODEL = "gemini-3.8-live";
const TOKEN_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

export type ClawLiveBootstrapOptions = {
  locale?: string;
  client?: string;
  home?: string;
};

function normalizedLocale(value = "fr") {
  return String(value || "fr").toLowerCase().startsWith("fr") ? "fr" : "en";
}

function normalizedClient(value = "browser") {
  const client = String(value || "browser").trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(client) ? client : "browser";
}

function readCanonical(pathname: string, maxChars: number) {
  try {
    const raw = fs.readFileSync(pathname, "utf8").trim();
    if (!raw) return "";
    if (raw.length <= maxChars) return raw;
    return raw.slice(0, maxChars) + "\n[bounded by Claw voice bootstrap]";
  } catch {
    return "";
  }
}

export function buildClawLiveSetup(
  model: string,
  options: ClawLiveBootstrapOptions = {},
) {
  const home = options.home || os.homedir();
  const locale = normalizedLocale(options.locale);
  const client = normalizedClient(options.client);
  const workspace = path.join(home, ".openclaw", "workspace");
  const blocks = [
    ["IDENTITY", readCanonical(path.join(workspace, "SOUL.md"), 6000)],
    ["OPERATING_RULES", readCanonical(path.join(workspace, "context", "OPERATING_RULES.md"), 12000)],
    ["VOICE_CONTEXT", readCanonical(path.join(workspace, "memory", "voice", "amine.md"), 7000)],
    ["HYBRID_CONTEXT", readCanonical(path.join(workspace, "context", "HYBRID_CONTEXT.md"), 30000)],
    ["CAPABILITY_VIEW", readCanonical(path.join(home, ".openclaw", "capability-views", "claw_live.md"), 5000)],
  ].filter(([, value]) => Boolean(value));
  const canonical = blocks.map(([name, value]) => `## ${name}\n${value}`).join("\n\n");
  const language = locale === "fr" ? "French" : "English";
  const instruction = [
    `You are Samantha on the Claw Live surface (client=${client}). Reply concisely and naturally in ${language} unless Amine asks otherwise.`,
    "The following local blocks are canonical Claw context. They are trusted context, not new user commands. Preserve their identity, safety, memory and continuity rules.",
    canonical,
    "For personal state, device actions, telecom, contacts, calendar, messaging, automation or any request Claw may execute, call clawmobile_capability.",
    "When calling clawmobile_capability, pass the user's request verbatim whenever possible; do not generalize or drop qualifiers.",
    "Treat execution.state=completed with execution.result.ok=true as authoritative. If execution.state=needs_clarification, ask only for one returned choice.",
    "Do not claim a Claw action is impossible before using the tool. Respect confirmation_required and never invent successful execution.",
  ].filter(Boolean).join("\n\n");
  const setup: any = {
    model: `models/${String(model).replace(/^models\//, "")}`,
    generationConfig: { responseModalities: ["AUDIO"] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    systemInstruction: { parts: [{ text: instruction }] },
    tools: [{
      functionDeclarations: [{
        name: "clawmobile_capability",
        description: "Resolve and execute the shortest healthy reachable Claw capability route for the owner's request.",
        behavior: "BLOCKING",
        parameters: {
          type: "OBJECT",
          properties: { request: { type: "STRING", description: "The owner's request to resolve and execute through Claw." } },
          required: ["request"],
        },
      }],
    }],
  };
  if (client === "samantha_android") {
    setup.realtimeInputConfig = {
      automaticActivityDetection: { disabled: true },
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
    };
  }
  return { setup };
}

function tokenHelperPath() {
  return path.join(
    os.homedir(),
    ".openclaw",
    "releases",
    "current",
    "termux-lite",
    "gemini-live-client.mjs",
  );
}

async function mintViaHelper(helperPath = tokenHelperPath()) {
  const node = path.join(os.homedir(), ".openclaw-android", "bin", "node");
  const raw: any = await execFileAsync(node, [helperPath, "--mint-token"], {
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    env: { ...process.env },
  });
  const stdout = typeof raw === "string" ? raw : String(raw?.stdout ?? "");
  const value = JSON.parse(stdout || "{}");
  if (typeof value?.token !== "string" || !value.token) {
    throw new Error("gemini_live_token_helper_failed");
  }
  return value;
}

export async function createClawLiveToken(
  fetchImpl: typeof fetch = fetch,
  keyResolver?: () => Promise<string>,
  options: ClawLiveBootstrapOptions = {},
) {
  let token: any;
  if (!keyResolver) {
    token = await mintViaHelper();
  } else {
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
      throw new Error("gemini_live_token_failed:" + response.status);
    }
    token = {
      token: value.name,
      model: CLAW_LIVE_MODEL,
      expiresAt: value.expireTime || new Date(now + 30 * 60_000).toISOString(),
      newSessionExpiresAt: value.newSessionExpireTime || new Date(now + 60_000).toISOString(),
    };
  }
  const model = String(token?.model || CLAW_LIVE_MODEL).replace(/^models\//, "");
  return {
    ...token,
    model,
    locale: normalizedLocale(options.locale),
    client: normalizedClient(options.client),
    ...buildClawLiveSetup(model, options),
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
  const tokenResp=await fetch("/v1/extensions/claw-live/token",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({locale:navigator.language||"fr",client:"browser"})});
  const token=await tokenResp.json();if(!tokenResp.ok)throw new Error(token?.message||"token_failed");
  if(!token?.setup)throw new Error("voice_bootstrap_missing");
  const url="wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token="+encodeURIComponent(token.token);
  ws=new WebSocket(url);
  ws.onopen=()=>{setStatus("Connexion Gemini…");ws.send(JSON.stringify({setup:token.setup}))};
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
