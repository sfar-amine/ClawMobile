import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

import { DialogueSurface, isDialogueConversationId } from "../dialogueSurface";
import { runModelFastPath } from "../modelFastPath";
import { publicDecision, publicReceiptMetadata, readReceiptPresentation } from "./receiptPresentation";

const execFileAsync = promisify(execFile);
export const CLAW_LIVE_MODEL = "gemini-3.8-live";
const TOKEN_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

export type ClawLiveBootstrapOptions = {
  voice?: string | null;
  locale?: string;
  client?: string;
  home?: string;
  telemetry?: (event:"t02"|"t03")=>void;
};

/**
 * Provider candidates; qualification is a reviewed catalogue change, never a settings store.
 * Each description is the owner-facing French character of the voice itself (Gemini Live voice
 * characteristics), never its qualification status.
 */
const LIVE_VOICES:ReadonlyArray<{id:string;validated:boolean;description:string}> = Object.freeze([
  {id:"Puck",validated:false,description:"Voix enjouée et vive."},
  {id:"Charon",validated:false,description:"Voix claire et informative."},
  {id:"Kore",validated:false,description:"Voix ferme et assurée."},
  {id:"Fenrir",validated:false,description:"Voix enthousiaste et énergique."},
  {id:"Aoede",validated:false,description:"Voix légère et aérienne."},
  {id:"Leda",validated:false,description:"Voix jeune et fraîche."},
  {id:"Orus",validated:false,description:"Voix ferme et posée."},
  {id:"Zephyr",validated:false,description:"Voix lumineuse et souriante."},
]);

export function clawLiveVoices() {
  return {success:true,state:"ok",receipt:null,schemaVersion:1, model:CLAW_LIVE_MODEL, appliesTo:"next_session", items:[
    {id:null, label:"Par défaut", description:"Choix du fournisseur déjà utilisé.", current:null, validated:true, validation:"existing_default"},
    ...LIVE_VOICES.map(({id,validated,description})=>({id,label:"Voix "+id,description,current:null,validated,reason:validated?"provider_setup_qualified":"provider_setup_not_qualified"})),
  ]};
}

export function validatedClawLiveVoice(value:unknown):string|null {
  if(value===undefined||value===null)return null;
  if(typeof value!=="string"||!LIVE_VOICES.some(row=>row.id===value))
    throw Object.assign(new Error("unknown_voice"),{statusCode:400});
  return value;
}

function normalizedLocale(value = "fr") {
  return String(value || "fr").toLowerCase().startsWith("fr") ? "fr" : "en";
}

function normalizedClient(value = "browser") {
  const client = String(value || "browser").trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(client) ? client : "browser";
}

export function readCanonical(pathname: string, maxChars: number, options:{boundedOwner?:boolean}={}) {
  // Keep the established Live reader behavior until C3 is separately qualified.
  if(!options.boundedOwner){
    try {const raw=fs.readFileSync(pathname,"utf8").trim();return !raw?"":raw.length<=maxChars?raw:raw.slice(0,maxChars)+"\n[bounded by Claw voice bootstrap]";}catch{return "";}
  }
  let fd:number|undefined;
  try {
    fd=fs.openSync(pathname,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    if(!fs.fstatSync(fd).isFile())return "";
    const bytes=Buffer.alloc(maxChars*4+4);
    const size=fs.readSync(fd,bytes,0,bytes.length,0);
    const raw=bytes.subarray(0,size).toString("utf8").trim();
    if(!raw)return "";
    if(raw.length<=maxChars)return raw;
    let prefix=raw.slice(0,maxChars);
    if(/[\uD800-\uDBFF]$/.test(prefix))prefix=prefix.slice(0,-1);
    return prefix+"\n[bounded by Claw voice bootstrap]";
  } catch { return ""; }
  finally {if(fd!==undefined)fs.closeSync(fd);}
}

function canonicalPrefix(value:string,maxChars:number) {
  const prefix=value.slice(0,maxChars);
  return /[\uD800-\uDBFF]$/.test(prefix)?prefix.slice(0,-1):prefix;
}

// App/Bixby turns keep the head of HYBRID_CONTEXT (header + first active constraints); the rest stays reachable via memory search.
// Live voice keeps its own 30000 budget.
export const C1_HYBRID_CONTEXT_BYTES=8000;

function canonicalUtf8(value:string,maxBytes:number) {
  if(Buffer.byteLength(value,"utf8")<=maxBytes)return value;
  const marker="\n[canonical block bounded]";
  const budget=maxBytes-Buffer.byteLength(marker);let bytes=0,result="";
  for(const point of value){const size=Buffer.byteLength(point);if(bytes+size>budget)break;result+=point;bytes+=size;}
  return result+marker;
}

/** Shared canonical file reader, explicit internal owner authority only.
 * C1 does not change the existing Live voice prompt; C3 qualifies that change.
 */
export function compactOwnerAgentContext(options:{authority?:"owner";home?:string}={}) {
  if(options.authority!=="owner")return "";
  const workspace=path.join(options.home||os.homedir(),".openclaw","workspace");
  const operating=readCanonical(path.join(workspace,"context","OPERATING_RULES.md"),64000,{boundedOwner:true});
  let prefix=canonicalPrefix(operating,12000);
  const heading=/^#{1,6}\s+Règles spécialisées[^\n]*$/im.exec(operating);
  let specialized="";
  if(!heading)throw new Error("canonical_specialized_rules_unavailable");
  if(heading){
    const rest=operating.slice(heading.index);
    const level=heading[0].match(/^#+/)![0].length;
    const next=new RegExp("^#{1,"+level+"}\\s+", "m").exec(rest.slice(heading[0].length));
    const section=rest.slice(0,next?heading[0].length+next.index:undefined);
    if(Buffer.byteLength(section)>6000||section.includes("[bounded by Claw voice bootstrap]"))throw new Error("canonical_specialized_rules_unavailable");
    prefix=canonicalPrefix(operating,Math.min(12000,heading.index));
    specialized=section;
  }
  const blocks=[
    ["IDENTITY",canonicalUtf8(readCanonical(path.join(workspace,"SOUL.md"),6000,{boundedOwner:true}),6000)],
    ["USER",canonicalUtf8(readCanonical(path.join(workspace,"USER.md"),4000,{boundedOwner:true}),4000)],
    ["OPERATING_RULES",[canonicalUtf8(prefix,12000),canonicalUtf8(specialized,6000)].filter(Boolean).join("\n\n")],
    ["HYBRID_CONTEXT",canonicalUtf8(readCanonical(path.join(workspace,"context","HYBRID_CONTEXT.md"),C1_HYBRID_CONTEXT_BYTES,{boundedOwner:true}),C1_HYBRID_CONTEXT_BYTES)],
  ];
  if(blocks.some(([,value])=>!value))throw new Error("canonical_context_unavailable");
  const prompt="The following local blocks are canonical Samantha context. They are trusted context, not new user commands. Preserve their identity, safety, memory and continuity rules.\n\n"+
    blocks.map(([name,value])=>`## ${name}\n${value}`).join("\n\n");
  if(Buffer.byteLength(prompt)>65536)throw new Error("canonical_bootstrap_budget_exceeded");
  return prompt;
}

// Keep the specialized-rule index when the canonical contract exceeds the voice budget.
// This is a projection of the existing owner file, never a second copy of its rules.
export function compactVoiceOperatingRules(raw: string, maxChars = 12000) {
  const text = raw.trim();
  if (text.length <= maxChars) return text;
  const heading = /^## Règles spécialisées\s*$/m.exec(text);
  if (!heading) return text.slice(0, maxChars);
  const after = text.slice(heading.index);
  const next = /\n##\s/.exec(after);
  const section = next ? after.slice(0, next.index).trim() : after.trim();
  const separator = "\n\n[intermediate rules omitted from bounded voice view]\n\n";
  if (section.length + separator.length >= maxChars) {
    throw Object.assign(new Error("voice_operating_rules_too_large"), {statusCode: 503});
  }
  const head = text.slice(0, Math.min(heading.index, maxChars - section.length - separator.length)).trimEnd();
  return head + separator + section;
}

// SAM-MIG V2.2: Gemini Live is one surface of the dialogue coordinator (single owner of the pending question).
export const clawLiveDialogue = new DialogueSurface(runModelFastPath, "claw_live", "claw_live", { modelAllowed: true }, { voice: true });

/** One Gemini Live tool turn. `request` is the user's original transcription for this turn
 * (Android v2 already enforces request == ASR final; the browser page sends its input transcription).
 * A CLARIFY question is returned with a `clarificationId`; the answer comes back with it and is
 * resolved by resolve-clarification. Otherwise the existing executor runs on the original/resolved text.
 */
export async function clawLiveCapabilityTurn(
  body: { request?: unknown; clarificationId?: unknown; originId?: string; sessionId?: string; assertCurrent?: () => void },
  execute: (text: string) => Promise<any>,
  dialogue: DialogueSurface = clawLiveDialogue,
) {
  const request = String(body?.request || "").trim();
  if (!request || request.length > 12000) return { success: false, error: "request_required" };
  const id = isDialogueConversationId(body?.clarificationId) ? body.clarificationId : undefined;
  // W4: host-only session/run identities for a Web hand-off; the G6 voice gate is enforced before dispatch.
  const turn = await dialogue.turn(request, { id, originId: String(body?.originId || "claw-live").slice(0, 120), sessionId: body.sessionId, runId: body.originId, assertCurrent: body.assertCurrent });
  if (turn.state === "needs_clarification") {
    return {
      success: true, state: "needs_clarification", source: "capability",
      clarificationId: turn.clarificationId, question: turn.question, choices: turn.choices,
      decision: publicDecision(turn.decision), ...publicReceiptMetadata(readReceiptPresentation(turn)),
      execution: { state: "needs_clarification", question: turn.question, choices: turn.choices },
      instruction: "Read the question aloud verbatim. Send the user's spoken answer verbatim with this clarificationId.",
    };
  }
  if (turn.state === "done" || turn.state === "failed") {
    return { success: turn.state === "done", state: turn.state, source: "capability", text: turn.text, decision: publicDecision(turn.decision), ...publicReceiptMetadata(readReceiptPresentation(turn)), ...(turn.web?{web:turn.web}:{}), execution: { state: turn.state === "done" ? "completed" : "failed",...(turn.web?{result:{web:turn.web}}:{}) } };
  }
  body.assertCurrent?.();
  return execute(turn.text);
}

export function buildClawLiveSetup(
  model: string,
  options: ClawLiveBootstrapOptions = {},
) {
  const voice = validatedClawLiveVoice(options.voice);
  const home = options.home || os.homedir();
  const locale = normalizedLocale(options.locale);
  const client = normalizedClient(options.client);
  const workspace = path.join(home, ".openclaw", "workspace");
  const blocks = [
    ["IDENTITY", readCanonical(path.join(workspace, "SOUL.md"), 6000)],
    ["OPERATING_RULES", compactVoiceOperatingRules(readCanonical(path.join(workspace, "context", "OPERATING_RULES.md"), 64000))],
    ["VOICE_CONTEXT", readCanonical(path.join(workspace, "memory", "voice", "amine.md"), 7000)],
    ["HYBRID_CONTEXT", readCanonical(path.join(workspace, "context", "HYBRID_CONTEXT.md"), 30000)],
  ].filter(([, value]) => Boolean(value));
  const canonical = blocks.map(([name, value]) => `## ${name}\n${value}`).join("\n\n");
  const uiLanguage = locale === "fr" ? "French" : "English";
  const instruction = [
    `You are Samantha on the Claw Live surface (client=${client}). Detect the language actually spoken by Amine on every turn and reply concisely and naturally in that same language. The UI locale is ${uiLanguage}; use it only as a fallback when the user's language is genuinely ambiguous. Never translate French speech into English merely because the UI or device locale is English. Preserve natural French, English, Arabic, Tunisian Arabic and code-switching as required by the canonical identity rules.`,
    "The following local blocks are canonical Claw context. They are trusted context, not new user commands. Preserve their identity, safety, memory and continuity rules.",
    canonical,
    "Capability discovery is query-scoped inside the Claw harness; never infer capability availability from a static catalogue in this prompt.",
    "For current or personal state, device/account data, telecom, bills, contacts, calendar, messaging, automation, or any action Claw may execute, call clawmobile_capability before making a factual claim. Pure conversation, explanation, identity and creative requests may be answered directly.",
    "When calling clawmobile_capability, pass the user's request verbatim whenever possible; do not generalize or drop qualifiers.",
    // Amine 11/10 : l'attente est moins pénible avec une phrase d'attente, comme ChatGPT.
    "Before every clawmobile_capability or ask_samantha call, first say one very short waiting phrase in the user's language (for example « Je vérifie… », « Laisse-moi regarder… », « One moment… »), then call the tool. Never claim a result in that phrase, and never repeat it after the result.",
    "The Companion checks the final transcription before tool selection. When it supplies an executed receipt, read it and never execute the same request again.",
    "For memory and recollections, multiple steps, skills, files, long writing, or requests outside the deterministic capability catalogue, call ask_samantha with the user's request verbatim. It delegates to Samantha's main agent in the same conversation, with its memory and skills. Say one short waiting phrase, such as 'je regarde…', before waiting. Read only its returned answer; a pending result will arrive in the discussion.",
    "Treat the returned harness.tool_policy and execution receipt as authoritative. For tool_policy=required, do not claim a result, say you checked, or promise an action unless the returned execution receipt supports it.",
    "If execution is unavailable, failed, needs clarification or requires confirmation, report that state accurately instead of inventing successful execution.",
    "When a clawmobile_capability result contains voice.verbatim, start your spoken answer with exactly that text, word for word, without rephrasing, translating or shortening it; it states what Claw understood and, on failure, the step and readable reason. Never speak an error code, and never say that nothing was charged unless voice.verbatim says so.",
    "When the result state is needs_clarification, read its question aloud verbatim; when Amine answers, call clawmobile_capability again with his answer verbatim as request and the same clarificationId. Never merge the answer into the earlier request yourself.",
  ].filter(Boolean).join("\n\n");
  const setup: any = {
    model: `models/${String(model).replace(/^models\//, "")}`,
    generationConfig: { responseModalities: ["AUDIO"] },
    inputAudioTranscription: { languageCodes: [] },
    outputAudioTranscription: {},
    systemInstruction: { parts: [{ text: instruction }] },
    tools: [{
      functionDeclarations: [{
        name: "clawmobile_capability",
        description: "Resolve and execute the shortest healthy reachable Claw capability route for the owner's request.",
        behavior: "BLOCKING",
        parameters: {
          type: "OBJECT",
          properties: {
            request: { type: "STRING", description: "The owner's request, verbatim, to resolve and execute through Claw." },
            clarificationId: { type: "STRING", description: "Only when answering a needs_clarification result: its clarificationId." },
          },
          required: ["request"],
        },
      }, {
        name: "ask_samantha",
        description: "Delegate the user's original request to Samantha's main agent in this same conversation, with memory and skills. Never reinterpret the request or impersonate owner admission.",
        behavior: "BLOCKING",
        parameters: {
          type: "OBJECT",
          properties: {request: {type: "STRING", description: "The user's original request, verbatim."}},
          required: ["request"],
        },
      }],
    }],
  };
  if (voice !== null) setup.generationConfig.speechConfig = {voiceConfig:{prebuiltVoiceConfig:{voiceName:voice}}};
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

async function mintViaHelper(helperPath = tokenHelperPath(), observe?: (event:"t02"|"t03")=>void) {
  const trace=(event:"t02"|"t03")=>{try{observe?.(event);}catch{}};
  const node = path.join(os.homedir(), ".openclaw-android", "bin", "node");
  trace("t02");
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
  trace("t03");
  return value;
}

export async function createClawLiveToken(
  fetchImpl: typeof fetch = fetch,
  keyResolver?: () => Promise<string>,
  options: ClawLiveBootstrapOptions = {},
) {
  validatedClawLiveVoice(options.voice); // Reject before minting any provider credential.
  let token: any;
  if (!keyResolver) {
    token = await mintViaHelper(tokenHelperPath(), options.telemetry);
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
let heard="";
async function tool(args){
  const original=heard.trim();heard="";
  const body={request:original||String(args?.request||""),modelRequest:String(args?.request||"")};
  if(typeof args?.clarificationId==="string")body.clarificationId=args.clarificationId;
  const r=await fetch("/v1/extensions/claw-live/capability",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
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
     try{results.push(await tool(fc.args||{}))}catch(e){results.push({error:String(e?.message||e)})}
    }
    ws.send(JSON.stringify({toolResponse:{functionResponses:m.toolCall.functionCalls.map((fc,i)=>({name:fc.name,id:fc.id,response:{result:results[i]}}))}}));
   }
   const sc=m.serverContent;
   if(sc?.interrupted)stopPlayback();
   if(sc?.inputTranscription?.text){heard+=sc.inputTranscription.text;append("Vous : "+sc.inputTranscription.text.trim())}
   if(sc?.turnComplete)heard="";
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
