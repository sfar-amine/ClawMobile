import http from "http";
import type { Duplex } from "stream";
import WebSocket, { WebSocketServer } from "ws";
import { createClawLiveToken, type ClawLiveBootstrapOptions } from "./clawLive";

const PROVIDER_URL="wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const SOCKET_PATH="/v1/extensions/claw-live/socket";
const DEFAULT_IDLE_MS=15*60_000;
const RESUME_HANDLE_TTL_MS=110*60_000;
const SETUP_TIMEOUT_MS=15_000;

type WarmState="cold"|"connecting"|"warm"|"reconnecting"|"error";
type TokenBundle={token:string;setup:any;expiresAt?:string;model?:string};
type LocalMeta={locale:string;client:string;sessionId:string};

type WarmDeps={
  tokenFactory?:(options:ClawLiveBootstrapOptions)=>Promise<TokenBundle>;
  WebSocketImpl?:typeof WebSocket;
  idleMs?:number;
  now?:()=>number;
};

function safeMeta(req:http.IncomingMessage):LocalMeta {
  const u=new URL(req.url||SOCKET_PATH,"http://127.0.0.1");
  const locale=String(u.searchParams.get("locale")||"fr").slice(0,32);
  const client=String(u.searchParams.get("client")||"samantha_android").replace(/[^A-Za-z0-9._-]/g,"").slice(0,64)||"samantha_android";
  const raw=String(u.searchParams.get("session")||"default");
  const sessionId=/^[A-Za-z0-9._:-]{1,160}$/.test(raw)?raw:"default";
  return {locale,client,sessionId};
}

function loopback(address?:string|null){
  return !address||address==="127.0.0.1"||address==="::1"||address==="::ffff:127.0.0.1";
}

export class ClawLiveWarmCore {
  private readonly tokenFactory:(options:ClawLiveBootstrapOptions)=>Promise<TokenBundle>;
  private readonly WebSocketImpl:typeof WebSocket;
  private readonly idleMs:number;
  private readonly now:()=>number;
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
  private stopped=false;

  constructor(deps:WarmDeps={}) {
    this.tokenFactory=deps.tokenFactory||((options)=>createClawLiveToken(fetch,undefined,options) as Promise<TokenBundle>);
    this.WebSocketImpl=deps.WebSocketImpl||WebSocket;
    this.idleMs=Math.max(60_000,deps.idleMs||Number(process.env.CLAW_LIVE_WARM_IDLE_MS)||DEFAULT_IDLE_MS);
    this.now=deps.now||(()=>Date.now());
  }

  status(){
    return {
      state:this.state,stage:this.stage,providerReady:this.providerReady,clients:this.localClients.size,
      conversationBound:Boolean(this.conversationId&&this.conversationId!=="__prewarm__"),resumable:this.hasValidResumeHandle(),historyLoaded:this.historyLoaded,
      connectedAt:this.connectedAt||null,readyAt:this.readyAt||null,lastUsedAt:this.lastUsedAt||null,
      lastSetupMs:this.lastSetupMs,resumedLast:this.resumedLast,lastError:this.lastError||null,idleMs:this.idleMs,
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
    this.localClients.add(ws);this.touch();
    ws.once("close",()=>{this.localClients.delete(ws);this.touch();});
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
    ws.send(JSON.stringify({warmReady:{historyRequired,resumed:this.resumedLast,setupMs:this.lastSetupMs,state:"warm"}}));
  }

  private async ensureConversation(meta:LocalMeta){
    const unbound=this.conversationId==="__prewarm__";
    const changed=this.conversationId&&!unbound&&this.conversationId!==meta.sessionId;
    if(changed)this.resetProvider("conversation_changed");
    if(!this.conversationId||unbound||meta.sessionId==="__prewarm__")this.conversationId=meta.sessionId;
    this.locale=meta.locale;this.client=meta.client;
    if(this.providerReady)return;
    if(this.connectPromise)return this.connectPromise;
    this.connectPromise=this.connectProvider(this.hasValidResumeHandle()).finally(()=>{this.connectPromise=null;});
    return this.connectPromise;
  }

  private async connectProvider(resume:boolean):Promise<void>{
    this.state=resume?"reconnecting":"connecting";this.stage="token";this.lastError="";this.connectStartedAt=this.now();
    let bundle:TokenBundle;
    try{
      bundle=await this.tokenFactory({locale:this.locale,client:"samantha_android"});
    }catch(e:any){this.failStage("token",e);throw e;}
    if(this.stopped)return;
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
      ws.on("open",()=>{opened=true;this.connectedAt=this.now();this.stage="setup";ws.send(JSON.stringify({setup}));});
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
          this.providerReady=true;this.state="warm";this.stage="ready";this.readyAt=this.now();this.lastSetupMs=this.readyAt-this.connectStartedAt;this.resumedLast=resume;this.armIdleTimer();
          const historyRequired=!resume&&!this.historyLoaded;
          for(const client of this.localClients)this.sendReady(client,historyRequired);
          resolve();return;
        }
        this.broadcast(raw);
      });
      ws.on("close",()=>{
        if(this.provider!==ws)return;
        const wasReady=this.providerReady;this.providerReady=false;this.provider=null;
        if(this.stopped)return;
        if(!wasReady&&!settled){fail("closed_before_ready",new Error("gemini_live_closed_before_ready"));return;}
        if(this.localClients.size>0||this.now()-this.lastUsedAt<this.idleMs)this.scheduleReconnect();else this.state="cold";
      });
    }).catch(async(e)=>{
      if(resume&&this.resumeHandle){this.resumeHandle="";this.resumeHandleAt=0;this.historyLoaded=false;return this.connectProvider(false);}
      throw e;
    });
  }

  private onLocalMessage(_client:WebSocket,data:WebSocket.RawData){
    this.touch();const raw=data.toString();
    try{
      const m=JSON.parse(raw);
      if(m?.warmControl?.historyLoaded===true){this.historyLoaded=true;return;}
      if(m?.warmControl?.touch===true)return;
    }catch{}
    if(this.providerReady&&this.provider?.readyState===WebSocket.OPEN)this.provider.send(raw);
  }

  private broadcast(raw:string){for(const c of this.localClients)if(c.readyState===WebSocket.OPEN)c.send(raw);}
  private failStage(stage:string,e:any){this.state="error";this.stage=stage;this.lastError=String(e?.message||e||stage).slice(0,160);console.warn(`[claw-live-warm] ${stage}: ${this.lastError}`);}
  private scheduleReconnect(){if(this.reconnectTimer||this.stopped)return;this.state="reconnecting";this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;void this.connectProvider(this.hasValidResumeHandle()).catch(()=>{});},250).unref();}
  private resetProvider(_reason:string,preserveResume=false){
    if(this.reconnectTimer)clearTimeout(this.reconnectTimer);this.reconnectTimer=null;if(this.setupTimer)clearTimeout(this.setupTimer);this.setupTimer=null;
    const p=this.provider;this.provider=null;this.providerReady=false;
    if(!preserveResume){this.resumeHandle="";this.resumeHandleAt=0;this.historyLoaded=false;this.conversationId="";}
    this.state="cold";this.stage=preserveResume&&this.hasValidResumeHandle()?"resumable_idle":"idle";this.resumedLast=false;
    try{p?.close();}catch{}
  }
  cool(reason="manual",preserveResume=false){this.resetProvider(reason,preserveResume);}
  shutdown(){this.stopped=true;if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=null;this.cool("shutdown",false);for(const c of this.localClients)try{c.close(1001,"shutdown");}catch{}this.localClients.clear();}
}

export const clawLiveWarmCore=new ClawLiveWarmCore();
const localServer=new WebSocketServer({noServer:true});
localServer.on("connection",(ws,req)=>{void clawLiveWarmCore.attach(ws,safeMeta(req));});

export function attachClawLiveWarmUpgrade(server:http.Server){
  server.on("upgrade",(req: http.IncomingMessage,socket:Duplex,head:Buffer)=>{
    let pathname="";try{pathname=new URL(req.url||"/","http://127.0.0.1").pathname;}catch{}
    if(pathname!==SOCKET_PATH||!loopback(req.socket.remoteAddress)){socket.destroy();return;}
    localServer.handleUpgrade(req,socket,head,(ws)=>localServer.emit("connection",ws,req));
  });
}

export function clawLiveWarmMeta(body:any):LocalMeta{
  const locale=String(body?.locale||"fr").slice(0,32);const client=String(body?.client||"samantha_android").replace(/[^A-Za-z0-9._-]/g,"").slice(0,64)||"samantha_android";
  const raw=String(body?.sessionId||body?.session||"default");const sessionId=/^[A-Za-z0-9._:-]{1,160}$/.test(raw)?raw:"default";return {locale,client,sessionId};
}
