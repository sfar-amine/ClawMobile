import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import {VoiceTurnProtocol} from "./voiceTurnProtocol";
import type { Duplex } from "stream";
import WebSocket, { WebSocketServer } from "ws";
import { createClawLiveToken, CLAW_LIVE_MODEL, type ClawLiveBootstrapOptions } from "./clawLive";
import { reconnectDelay } from "./reconnectPolicy";

const PROVIDER_URL="wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const SOCKET_PATH="/v1/extensions/claw-live/socket";
const DEFAULT_IDLE_MS=15*60_000;
const RESUME_HANDLE_TTL_MS=110*60_000;
const SETUP_TIMEOUT_MS=15_000;

type WarmState="cold"|"connecting"|"warm"|"reconnecting"|"error";
type TokenBundle={token:string;setup:any;expiresAt?:string;model?:string};
type LocalMeta={locale:string;client:string;sessionId:string;protocol?:number;sessionEpoch?:string};

type WarmDeps={
  tokenFactory?:(options:ClawLiveBootstrapOptions)=>Promise<TokenBundle>;
  WebSocketImpl?:typeof WebSocket;
  idleMs?:number;
  now?:()=>number;
  retryDelay?:(attempt:number)=>number;
};

function safeMeta(req:http.IncomingMessage):LocalMeta {
  const u=new URL(req.url||SOCKET_PATH,"http://127.0.0.1");
  const locale=String(u.searchParams.get("locale")||"fr").slice(0,32);
  const client=String(u.searchParams.get("client")||"samantha_android").replace(/[^A-Za-z0-9._-]/g,"").slice(0,64)||"samantha_android";
  const raw=String(u.searchParams.get("session")||"default");
  const sessionId=/^[A-Za-z0-9._:-]{1,160}$/.test(raw)?raw:"default";
  const sessionEpoch=String(u.searchParams.get("epoch")||"");
  const protocol=u.searchParams.get("protocol")==="2"?2:1;
  return {locale,client,sessionId,protocol,sessionEpoch};
}

function loopback(address?:string|null){
  return !address||address==="127.0.0.1"||address==="::1"||address==="::ffff:127.0.0.1";
}

export class ClawLiveWarmCore {
  private readonly tokenFactory:(options:ClawLiveBootstrapOptions)=>Promise<TokenBundle>;
  private readonly WebSocketImpl:typeof WebSocket;
  private readonly idleMs:number;
  private readonly now:()=>number;
  private readonly retryDelay:(attempt:number)=>number;
  private provider:WebSocket|null=null;
  private providerReady=false;
  private state:WarmState="cold";
  private stage="idle";
  private lastError="";
  private conversationId="";
  private locale="fr";
  private client="samantha_android";
  private resumeHandle="";
  private resumeHandleAt=0;
  private historyLoaded=false;
  private localClients=new Set<WebSocket>();
  private protocols=new Map<WebSocket,VoiceTurnProtocol>();
  private clientMeta=new Map<WebSocket,LocalMeta>();
  private connectPromise:Promise<void>|null=null;
  private idleTimer:NodeJS.Timeout|null=null;
  private reconnectTimer:NodeJS.Timeout|null=null;
  private setupTimer:NodeJS.Timeout|null=null;
  private connectedAt=0;
  private readyAt=0;
  private lastUsedAt=0;
  private connectStartedAt=0;
  private lastSetupMs:number|null=null;
  private resumedLast=false;
  private reconnectAttempts=0;
  private stopped=false;
  private connectionGeneration=0;
  private pendingConnects=new Set<()=>void>();

  constructor(deps:WarmDeps={}) {
    this.tokenFactory=deps.tokenFactory||((options)=>createClawLiveToken(fetch,undefined,options) as Promise<TokenBundle>);
    this.WebSocketImpl=deps.WebSocketImpl||WebSocket;
    this.idleMs=Math.max(60_000,deps.idleMs||Number(process.env.CLAW_LIVE_WARM_IDLE_MS)||DEFAULT_IDLE_MS);
    this.now=deps.now||(()=>Date.now());
    this.retryDelay=deps.retryDelay||reconnectDelay;
  }

  status(){
    return {
      state:this.state,stage:this.stage,providerReady:this.providerReady,clients:this.localClients.size,
      bargeIn:readBargeInProfile(),protocolVersion:2,
      conversationBound:Boolean(this.conversationId&&this.conversationId!=="__prewarm__"),resumable:this.hasValidResumeHandle(),historyLoaded:this.historyLoaded,
      connectedAt:this.connectedAt||null,readyAt:this.readyAt||null,lastUsedAt:this.lastUsedAt||null,
      lastSetupMs:this.lastSetupMs,resumedLast:this.resumedLast,reconnectAttempts:this.reconnectAttempts,
      lastError:this.lastError||null,idleMs:this.idleMs,
    };
  }

  private armIdleTimer(){
    if(this.idleTimer)clearTimeout(this.idleTimer);
    if(!this.lastUsedAt)return;
    const remaining=Math.max(100,this.idleMs-(this.now()-this.lastUsedAt)+100);
    this.idleTimer=setTimeout(()=>{
      if(this.localClients.size===0&&this.now()-this.lastUsedAt>=this.idleMs)this.cool("idle_timeout",true);
    },remaining).unref();
  }
  private touch(){this.lastUsedAt=this.now();this.armIdleTimer();}
  private hasValidResumeHandle(){
    if(!this.resumeHandle)return false;
    if(!this.resumeHandleAt||this.now()-this.resumeHandleAt>RESUME_HANDLE_TTL_MS){
      this.resumeHandle="";this.resumeHandleAt=0;return false;
    }
    return true;
  }

  async prewarmDefault(locale="fr"){
    return this.prewarm({locale,client:"samantha_android",sessionId:"__prewarm__"});
  }

  async prewarm(meta:LocalMeta){
    this.touch();
    await this.ensureConversation(meta);
    return this.status();
  }

  async attach(ws:WebSocket,meta:LocalMeta){
    if(this.localClients.size>0) {ws.close(1008,"voice_owner_busy");return;}
    if(meta.protocol===2&&!/^[A-Za-z0-9._:-]{1,160}$/.test(meta.sessionEpoch||"")) {ws.close(1008,"invalid_voice_epoch");return;}
    this.localClients.add(ws);this.clientMeta.set(ws,meta);this.touch();
    ws.once("close",()=>{this.localClients.delete(ws);this.protocols.get(ws)?.close();this.protocols.delete(ws);this.clientMeta.delete(ws);this.touch();if(meta.protocol===2)this.resetProvider("v2_owner_detached");});
    ws.on("message",(data)=>this.onLocalMessage(ws,data));
    const readyBefore=this.providerReady;
    try{
      await this.ensureConversation(meta);
      if(readyBefore&&this.providerReady)this.sendReady(ws,!this.historyLoaded);
    }catch{
      if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({warmError:{stage:this.stage,code:this.lastError||"warm_unavailable"}}));
    }
  }

  private sendReady(ws:WebSocket,historyRequired:boolean){
    if(ws.readyState!==WebSocket.OPEN)return;
    const meta=this.clientMeta.get(ws);
    if(meta?.protocol===2&&!this.protocols.has(ws))this.protocols.set(ws,new VoiceTurnProtocol(this.connectionGeneration,meta.sessionEpoch!,
      value=>{if(this.providerReady&&this.provider?.readyState===WebSocket.OPEN)this.provider.send(JSON.stringify(value));},
      value=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(value));}));
    ws.send(JSON.stringify({warmReady:{historyRequired,resumed:this.resumedLast,setupMs:this.lastSetupMs,state:"warm",
      protocolVersion:meta?.protocol===2?2:1,connectionEpoch:this.connectionGeneration,sessionEpoch:meta?.sessionEpoch,
      bargeIn:readBargeInProfile()}}));
  }

  private async ensureConversation(meta:LocalMeta){
    if(this.stopped)throw new Error("warm_connect_cancelled");
    // Lifecycle prewarm must not unbind an active conversation.
    if(meta.sessionId==="__prewarm__"&&this.conversationId)meta={...meta,sessionId:this.conversationId};
    const unbound=this.conversationId==="__prewarm__";
    const changed=this.conversationId&&!unbound&&this.conversationId!==meta.sessionId;
    if(changed&&this.localClients.size>0&&![...this.clientMeta.values()].every(v=>v.sessionId===meta.sessionId))throw new Error("voice_owner_busy");
    if(changed)this.resetProvider("conversation_changed");
    if(!this.conversationId||unbound||meta.sessionId==="__prewarm__")this.conversationId=meta.sessionId;
    this.locale=meta.locale;this.client=meta.client;
    if(this.providerReady)return;
    if(this.connectPromise)return this.connectPromise;
    if(this.reconnectTimer)clearTimeout(this.reconnectTimer);this.reconnectTimer=null;
    const generation=this.connectionGeneration;
    const pending=this.connectForeground(3,generation).finally(()=>{if(this.connectPromise===pending)this.connectPromise=null;});
    this.connectPromise=pending;
    return pending;
  }

  private delayForRetry(attempt:number){
    const ms=Math.max(0,this.retryDelay(attempt));
    if(ms===0)return Promise.resolve();
    return new Promise<void>((resolve)=>{const timer=setTimeout(resolve,ms);timer.unref();});
  }

  /** Foreground Voice gets a bounded fast retry window; pre-roll keeps microphone capture lossless in RAM meanwhile. */
  private async connectForeground(maxAttempts=3,generation=this.connectionGeneration):Promise<void>{
    let last:any=new Error("gemini_live_connect_failed");
    for(let attempt=0;attempt<maxAttempts;attempt++){
      try{
        if(this.stopped||generation!==this.connectionGeneration)throw new Error("warm_connect_cancelled");
        await this.connectProvider(this.hasValidResumeHandle(),generation);
        return;
      }catch(error:any){
        last=error;
        if(this.stopped||generation!==this.connectionGeneration)throw error;
        if(attempt+1>=maxAttempts)break;
        this.state="reconnecting";this.stage="backoff";
        await this.delayForRetry(attempt);
      }
    }
    throw last;
  }

  private async connectProvider(resume:boolean,generation=this.connectionGeneration):Promise<void>{
    if(this.stopped||generation!==this.connectionGeneration)throw new Error("warm_connect_cancelled");
    let cancel!:()=>void;
    const cancelled=new Promise<void>((_resolve,reject)=>{cancel=()=>reject(new Error("warm_connect_cancelled"));});
    this.pendingConnects.add(cancel);
    try{await Promise.race([this.connectProviderAttempt(resume,generation),cancelled]);}
    finally{this.pendingConnects.delete(cancel);}
  }

  private async connectProviderAttempt(resume:boolean,generation:number):Promise<void>{
    this.state=resume?"reconnecting":"connecting";this.stage="token";this.lastError="";this.connectStartedAt=this.now();
    let bundle:TokenBundle;
    try{
      bundle=await this.tokenFactory({locale:this.locale,client:"samantha_android"});
    }catch(e:any){if(generation===this.connectionGeneration&&!this.stopped)this.failStage("token",e);throw e;}
    if(this.stopped||generation!==this.connectionGeneration)throw new Error("warm_connect_cancelled");
    const setup=JSON.parse(JSON.stringify(bundle.setup||{}));
    setup.sessionResumption=resume&&this.resumeHandle?{handle:this.resumeHandle}:{};
    setup.contextWindowCompression={slidingWindow:{}};
    this.stage="websocket";
    const url=PROVIDER_URL+"?access_token="+encodeURIComponent(bundle.token);
    await new Promise<void>((resolve,reject)=>{
      const ws=new this.WebSocketImpl(url);
      this.provider=ws;this.providerReady=false;let opened=false;let settled=false;
      const fail=(stage:string,error:any)=>{
        if(settled)return;settled=true;if(this.setupTimer)clearTimeout(this.setupTimer);this.setupTimer=null;
        this.failStage(stage,error);try{ws.close();}catch{};reject(error instanceof Error?error:new Error(String(error)));
      };
      this.setupTimer=setTimeout(()=>fail("setup_timeout",new Error("gemini_live_setup_timeout")),SETUP_TIMEOUT_MS).unref();
      ws.on("open",()=>{if(this.provider!==ws||generation!==this.connectionGeneration)return;opened=true;this.connectedAt=this.now();this.stage="setup";ws.send(JSON.stringify({setup}));});
      ws.on("error",(e)=>{if(this.provider!==ws)return;if(!this.providerReady)fail(opened?"websocket":"connect",e);});
      ws.on("message",(data)=>{
        if(this.provider!==ws)return;
        let m:any;const raw=data.toString();try{m=JSON.parse(raw);}catch{return;}
        if(m.sessionResumptionUpdate){
          const u=m.sessionResumptionUpdate;
          if(u.resumable&&typeof u.newHandle==="string"&&u.newHandle){this.resumeHandle=u.newHandle;this.resumeHandleAt=this.now();}
          return;
        }
        if(m.goAway){this.stage="goaway";return;}
        if(m.error){if(!this.providerReady)fail("provider_error",new Error(String(m.error?.message||"provider_error")));else this.broadcast(raw);return;}
        if(m.setupComplete!==undefined){
          if(settled)return;settled=true;if(this.setupTimer)clearTimeout(this.setupTimer);this.setupTimer=null;
          this.providerReady=true;this.state="warm";this.stage="ready";this.readyAt=this.now();this.lastSetupMs=this.readyAt-this.connectStartedAt;this.resumedLast=resume;this.reconnectAttempts=0;this.armIdleTimer();
          const historyRequired=!resume&&!this.historyLoaded;
          for(const client of this.localClients)this.sendReady(client,historyRequired);
          resolve();return;
        }
        this.broadcast(raw);
      });
      ws.on("close",()=>{
        if(this.provider!==ws)return;
        const wasReady=this.providerReady;this.providerReady=false;this.provider=null;
        for(const [client] of this.protocols)client.close(1012,"voice_connection_replaced");
        this.protocols.clear();
        if(this.stopped)return;
        if(!wasReady&&!settled){fail("closed_before_ready",new Error("gemini_live_closed_before_ready"));return;}
        if(this.localClients.size>0||this.now()-this.lastUsedAt<this.idleMs)this.scheduleReconnect();else this.state="cold";
      });
    }).catch(async(e)=>{
      if(this.stopped||generation!==this.connectionGeneration)throw e;
      if(resume&&this.resumeHandle){this.resumeHandle="";this.resumeHandleAt=0;this.historyLoaded=false;return this.connectProvider(false,generation);}
      throw e;
    });
  }

  private onLocalMessage(_client:WebSocket,data:WebSocket.RawData){
    if(!this.localClients.has(_client))return;
    this.touch();const raw=data.toString();
    const version2=this.clientMeta.get(_client)?.protocol===2;
    if(version2&&!this.protocols.has(_client))return;
    if(version2&&raw.length>2_000_000){_client.close(1009,"voice_message_budget");return;}
    try{
      const m=JSON.parse(raw);
      if(m?.warmControl?.historyLoaded===true){this.historyLoaded=true;return;}
      if(m?.warmControl?.touch===true)return;
      const protocol=this.protocols.get(_client);if(protocol){protocol.receive(m);return;}
    }catch{if(version2){_client.close(1008,"invalid_voice_message");return;}}
    if(this.providerReady&&this.provider?.readyState===WebSocket.OPEN)this.provider.send(raw);
  }

  private broadcast(raw:string){
    for(const c of this.localClients)if(c.readyState===WebSocket.OPEN) {
      const protocol=this.protocols.get(c);
      if(protocol) {try{protocol.provider(JSON.parse(raw));}catch{c.close(1011,"voice_protocol_error");}}
      else c.send(raw);
    }
  }
  executeVoiceCapability(meta:any,request:string,run:()=>Promise<any>):Promise<any> {
    const entry=[...this.protocols.values()].find(p=>p.sessionEpoch===meta?.sessionEpoch&&p.connectionEpoch===meta?.connectionEpoch);
    if(!entry)throw Object.assign(new Error("voice_session_not_owned"),{statusCode:409});
    return entry.execute(String(meta?.turnId||""),request,run);
  }
  private failStage(stage:string,e:any){this.state="error";this.stage=stage;this.lastError=String(e?.message||e||stage).slice(0,160);console.warn(`[claw-live-warm] ${stage}: ${this.lastError}`);}
  private scheduleReconnect(){
    if(this.reconnectTimer||this.stopped)return;
    if(this.localClients.size===0&&this.now()-this.lastUsedAt>=this.idleMs){this.state="cold";return;}
    this.state="reconnecting";this.stage="backoff";
    const delay=Math.max(0,this.retryDelay(this.reconnectAttempts++));
    this.reconnectTimer=setTimeout(()=>{
      this.reconnectTimer=null;
      if(this.connectPromise)return;
      const generation=this.connectionGeneration;
      const pending=this.connectProvider(this.hasValidResumeHandle(),generation).finally(()=>{if(this.connectPromise===pending)this.connectPromise=null;});
      this.connectPromise=pending;
      void pending.catch(()=>{if(generation===this.connectionGeneration&&!this.stopped)this.scheduleReconnect();});
    },delay);
    this.reconnectTimer.unref();
  }
  private resetProvider(_reason:string,preserveResume=false){
    this.connectionGeneration++;
    for(const cancel of this.pendingConnects)cancel();
    this.pendingConnects.clear();this.connectPromise=null;
    if(this.reconnectTimer)clearTimeout(this.reconnectTimer);this.reconnectTimer=null;if(this.setupTimer)clearTimeout(this.setupTimer);this.setupTimer=null;
    const p=this.provider;this.provider=null;this.providerReady=false;
    if(!preserveResume){this.resumeHandle="";this.resumeHandleAt=0;this.historyLoaded=false;this.conversationId="";}
    this.state="cold";this.stage=preserveResume&&this.hasValidResumeHandle()?"resumable_idle":"idle";this.resumedLast=false;this.reconnectAttempts=0;
    try{p?.close();}catch{}
  }
  cool(reason="manual",preserveResume=false){this.resetProvider(reason,preserveResume);}
  shutdown(){this.stopped=true;if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=null;this.cool("shutdown",false);for(const c of this.localClients)try{c.close(1001,"shutdown");}catch{}this.localClients.clear();}
}

export const clawLiveWarmCore=new ClawLiveWarmCore();
const localServer=new WebSocketServer({noServer:true,maxPayload:2*1024*1024});
localServer.on("connection",(ws,req)=>{void clawLiveWarmCore.attach(ws,safeMeta(req));});

export function attachClawLiveWarmUpgrade(server:http.Server){
  server.on("upgrade",(req: http.IncomingMessage,socket:Duplex,head:Buffer)=>{
    let pathname="";try{pathname=new URL(req.url||"/","http://127.0.0.1").pathname;}catch{}
    if(pathname!==SOCKET_PATH||!loopback(req.socket.remoteAddress)||req.headers.origin){socket.destroy();return;}
    localServer.handleUpgrade(req,socket,head,(ws)=>localServer.emit("connection",ws,req));
  });
}

export function clawLiveWarmMeta(body:any):LocalMeta{
  const locale=String(body?.locale||"fr").slice(0,32);const client=String(body?.client||"samantha_android").replace(/[^A-Za-z0-9._-]/g,"").slice(0,64)||"samantha_android";
  const raw=String(body?.sessionId||body?.session||"default");const sessionId=/^[A-Za-z0-9._:-]{1,160}$/.test(raw)?raw:"default";return {locale,client,sessionId};
}

/** Optional fields in the existing plugin configuration, not a second settings store. */
function readBargeInProfile(){
  try {
    const config=JSON.parse(fs.readFileSync(path.join(os.homedir(),".openclaw/openclaw.json"),"utf8"));
    const profile=config?.plugins?.entries?.["openclaw-plugin-mobile-ui"]?.config?.voiceBargeIn;
    const routes=Array.isArray(profile?.qualifiedRoutes)?profile.qualifiedRoutes.filter((v:any)=>typeof v==="string"&&v.length<=512).slice(0,16):[];
    return {supported:true,enabled:profile?.enabled===true&&profile?.protocolModel===CLAW_LIVE_MODEL,qualifiedRoutes:routes,protocolModel:profile?.protocolModel||null,transcriptionBoundary:"android_speech_service"};
  } catch {return {supported:true,enabled:false,qualifiedRoutes:[],transcriptionBoundary:"android_speech_service"};}
}
