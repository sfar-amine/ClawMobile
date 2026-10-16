import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import {randomUUID} from "crypto";
import {VoiceTelemetry, type VoiceTelemetryCode} from "./voiceTelemetry";
import {VoiceTurnProtocol} from "./voiceTurnProtocol";
import type { Duplex } from "stream";
import WebSocket, { WebSocketServer } from "ws";
import { createClawLiveToken, validatedClawLiveVoice, CLAW_LIVE_MODEL, type ClawLiveBootstrapOptions } from "./clawLive";
import { reconnectDelay } from "./reconnectPolicy";
import { VoiceUnderstandingState } from "./clawLiveUnderstanding";

const PROVIDER_URL="wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const SOCKET_PATH="/v1/extensions/claw-live/socket";
const DEFAULT_IDLE_MS=15*60_000;
const RESUME_HANDLE_TTL_MS=110*60_000;
const SETUP_TIMEOUT_MS=15_000;

type WarmState="cold"|"connecting"|"warm"|"reconnecting"|"error";
type TokenBundle={token:string;setup:any;expiresAt?:string;model?:string};
type LocalMeta={voice?:string|null;locale:string;client:string;sessionId:string;protocol?:number;sessionEpoch?:string;endpointing?:string};

type WarmDeps={
  tokenFactory?:(options:ClawLiveBootstrapOptions)=>Promise<TokenBundle>;
  WebSocketImpl?:typeof WebSocket;
  idleMs?:number;
  now?:()=>number;
  retryDelay?:(attempt:number)=>number;
  telemetry?:VoiceTelemetry;
  ownerHandoffWaitMs?:number;
};

function safeMeta(req:http.IncomingMessage):LocalMeta {
  const u=new URL(req.url||SOCKET_PATH,"http://127.0.0.1");
  const locale=String(u.searchParams.get("locale")||"fr").slice(0,32);
  const client=String(u.searchParams.get("client")||"samantha_android").replace(/[^A-Za-z0-9._-]/g,"").slice(0,64)||"samantha_android";
  const raw=String(u.searchParams.get("session")||"default");
  const sessionId=/^[A-Za-z0-9._:-]{1,160}$/.test(raw)?raw:"default";
  const sessionEpoch=String(u.searchParams.get("epoch")||"");
  const protocol=u.searchParams.get("protocol")==="2"?2:1;
  return {voice:validatedClawLiveVoice(u.searchParams.get("voice")),locale,client,sessionId,protocol,sessionEpoch,endpointing:u.searchParams.get("endpointing")||"silero"};
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
  private voice:string|null=null;
  private lastOwnerVoice:string|null=null;
  private client="samantha_android";
  private resumeHandle="";
  private resumeHandleAt=0;
  private historyLoaded=false;
  /** Legacy (v1) turn left open by the owner: an unanswered tool call or an unfinished turn poisons the shared provider
   *  session (S24 11/10: the next voice launch got an empty turnComplete for real speech). */
  private legacyOpenTurn=false;
  private legacyPendingTools=new Set<string>();
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
  private detachWaiters=new Set<()=>void>();
  private readonly ownerHandoffWaitMs:number;
  private readonly telemetry:VoiceTelemetry;
  private telemetrySid="";
  private telemetryTurns=new Map<string,number>();
  private clientWarmHit=new Map<WebSocket,boolean>();
  /** Lot 41 piste 2: ephemeral « Compris / Ce n'est pas ça » slot of the single voice owner. */
  readonly understanding=new VoiceUnderstandingState(()=>this.now());

  constructor(deps:WarmDeps={}) {
    this.tokenFactory=deps.tokenFactory||((options)=>createClawLiveToken(fetch,undefined,options) as Promise<TokenBundle>);
    this.WebSocketImpl=deps.WebSocketImpl||WebSocket;
    this.idleMs=Math.max(60_000,deps.idleMs||Number(process.env.CLAW_LIVE_WARM_IDLE_MS)||DEFAULT_IDLE_MS);
    this.now=deps.now||(()=>Date.now());
    this.retryDelay=deps.retryDelay||reconnectDelay;
    this.ownerHandoffWaitMs=Math.max(1,Math.min(2_000,deps.ownerHandoffWaitMs??750));
    this.telemetry=deps.telemetry||new VoiceTelemetry();
  }

  status(){
    return {
      state:this.state,stage:this.stage,providerReady:this.providerReady,clients:this.localClients.size,
      bargeIn:readBargeInProfile(),protocolVersion:2,
      conversationBound:Boolean(this.conversationId&&this.conversationId!=="__prewarm__"),resumable:this.hasValidResumeHandle(),historyLoaded:this.historyLoaded,
      connectedAt:this.connectedAt||null,readyAt:this.readyAt||null,lastUsedAt:this.lastUsedAt||null,
      lastSetupMs:this.lastSetupMs,resumedLast:this.resumedLast,reconnectAttempts:this.reconnectAttempts,
      lastError:this.lastError||null,idleMs:this.idleMs,telemetry:this.telemetry.status(),
    };
  }

  private trace(ev:VoiceTelemetryCode,turn=0,x:Record<string,number|boolean>={}) {
    if(this.telemetrySid)this.telemetry.emit(this.telemetrySid,turn,ev,{connection:this.connectionGeneration,...x});
  }
  private observeTurn(ev:string,id:string,x:Record<string,number|boolean>={}) {
    if(ev==="input_start"&&!this.telemetryTurns.has(id)&&this.telemetryTurns.size<64)this.telemetryTurns.set(id,this.telemetryTurns.size+1);
    const turn=this.telemetryTurns.get(id);
    if(turn!==undefined&&ev!=="input_start")this.trace(ev as VoiceTelemetryCode,turn,x);
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
    return this.prewarm({locale,client:"samantha_android",sessionId:"__prewarm__",voice:this.lastOwnerVoice});
  }

  async prewarm(meta:LocalMeta){
    validatedClawLiveVoice(meta.voice);
    this.touch();
    if(meta.sessionId!=="__prewarm__"&&this.localClients.size>0&&this.conversationId&&this.conversationId!==meta.sessionId)await this.waitForOwnerDetach();
    this.trace("t01");
    await this.ensureConversation(meta);
    return this.status();
  }

  private waitForOwnerDetach(){
    if(this.localClients.size===0)return Promise.resolve();
    if(this.detachWaiters.size>=8)return Promise.reject(new Error("voice_owner_busy"));
    return new Promise<void>((resolve,reject)=>{
      let done=false;
      const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);this.detachWaiters.delete(release);error?reject(error):resolve();};
      const release=()=>finish();
      const timer=setTimeout(()=>finish(new Error("voice_owner_busy")),this.ownerHandoffWaitMs);
      this.detachWaiters.add(release);
      if(this.localClients.size===0)release();
    });
  }
  private releaseDetachWaiters(){for(const release of [...this.detachWaiters])release();}

  async attach(ws:WebSocket,meta:LocalMeta){
    validatedClawLiveVoice(meta.voice);
    if(meta.endpointing&&meta.endpointing!=="silero"){
      if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({warmError:{stage:"protocol",code:"endpointing_not_supported"}}));
      ws.close(1008,"endpointing_not_supported");return;
    }
    if(this.localClients.size>0) {ws.close(1008,"voice_owner_busy");return;}
    if(meta.protocol===2&&!/^[A-Za-z0-9._:-]{1,160}$/.test(meta.sessionEpoch||"")) {ws.close(1008,"invalid_voice_epoch");return;}
    if(meta.protocol===2&&this.telemetrySid!==meta.sessionEpoch){this.telemetrySid=meta.sessionEpoch!;this.telemetryTurns.clear();}
    else if(meta.protocol!==2){
      // A legacy attach is a distinct telemetry session even when the same
      // conversation/provider is reused. Return the sid for app correlation.
      meta={...meta,sessionEpoch:/^[A-Za-z0-9._:-]{1,160}$/.test(meta.sessionEpoch||"")?meta.sessionEpoch:randomUUID()};
      this.telemetrySid=meta.sessionEpoch!;this.telemetryTurns.clear();
    }
    this.trace("t01");
    const readyBefore=this.providerReady,generationBefore=this.connectionGeneration;
    this.localClients.add(ws);this.clientMeta.set(ws,meta);this.clientWarmHit.set(ws,false);this.touch();
    ws.once("close",(code:number)=>{
      const legacyStale=meta.protocol!==2&&(this.legacyOpenTurn||this.legacyPendingTools.size>0);
      const rewarm=(meta.protocol===2||legacyStale)&&code===1000&&this.providerReady&&!this.stopped;
      this.localClients.delete(ws);this.protocols.get(ws)?.close();this.protocols.delete(ws);this.clientMeta.delete(ws);this.clientWarmHit.delete(ws);this.touch();
      if(meta.protocol===2)this.resetProvider("v2_owner_detached");
      else if(legacyStale)this.resetProvider("legacy_owner_detached_mid_turn");
      if(this.telemetrySid)void this.telemetry.closeSession(this.telemetrySid);
      this.telemetrySid="";this.telemetryTurns.clear();
      const guardedHandoff=this.detachWaiters.size>0;this.releaseDetachWaiters();
      // Fresh unbound generation: old Voice turns/history never survive detach.
      // Reuse the existing bounded prewarm and shared connection promise.
      if(rewarm&&!guardedHandoff)void this.prewarmDefault(meta.locale).catch(()=>{});
    });
    ws.on("message",(data)=>this.onLocalMessage(ws,data));
    try{
      await this.ensureConversation(meta,true);
      this.lastOwnerVoice=this.voice;
      if(readyBefore&&this.providerReady&&generationBefore===this.connectionGeneration){this.clientWarmHit.set(ws,true);this.sendReady(ws,!this.historyLoaded);}
    }catch{
      if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({warmError:{stage:this.stage,code:this.lastError||"warm_unavailable"}}));
    }
  }

  private sendReady(ws:WebSocket,historyRequired:boolean){
    if(ws.readyState!==WebSocket.OPEN)return;
    const meta=this.clientMeta.get(ws);
    const warmHit=this.clientWarmHit.get(ws)===true;
    if(meta?.protocol===2&&!this.protocols.has(ws))this.protocols.set(ws,new VoiceTurnProtocol(this.connectionGeneration,meta.sessionEpoch!,
      value=>{if(this.providerReady&&this.provider?.readyState===WebSocket.OPEN)this.provider.send(JSON.stringify(value));},
      value=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(value));},
      (ev,id,x)=>this.observeTurn(ev,id,x),undefined,warmHit));
    this.trace("t07",0,{cached:warmHit});
    ws.send(JSON.stringify({warmReady:{historyRequired,resumed:this.resumedLast,setupMs:this.lastSetupMs,state:"warm",
      protocolVersion:meta?.protocol===2?2:1,connectionEpoch:this.connectionGeneration,sessionEpoch:meta?.sessionEpoch,
      bargeIn:readBargeInProfile()}}));
  }

  private async ensureConversation(meta:LocalMeta,newOwner=false){
    if(this.stopped)throw new Error("warm_connect_cancelled");
    // Lifecycle prewarm must not unbind an active conversation.
    if(meta.sessionId==="__prewarm__"&&this.conversationId)meta={...meta,sessionId:this.conversationId,voice:this.voice};
    const unbound=this.conversationId==="__prewarm__";
    const changed=this.conversationId&&!unbound&&this.conversationId!==meta.sessionId;
    if(changed&&this.localClients.size>0&&![...this.clientMeta.values()].every(v=>v.sessionId===meta.sessionId))throw new Error("voice_owner_busy");
    const desiredVoice=validatedClawLiveVoice(meta.voice);
    // Only a new conversation/connection may adopt a preference. An active owner keeps its setup.
    if((unbound||newOwner)&&desiredVoice!==this.voice)this.resetProvider("voice_selected_before_owner");
    if(changed)this.resetProvider("conversation_changed");
    if(!this.conversationId||unbound||changed)this.voice=desiredVoice;
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
    const telemetrySid=this.telemetrySid;
    try{
      bundle=await this.tokenFactory({voice:this.voice,locale:this.locale,client:"samantha_android",telemetry:ev=>{if(generation===this.connectionGeneration&&telemetrySid===this.telemetrySid)this.trace(ev);}});
    }catch(e:any){if(generation===this.connectionGeneration&&!this.stopped)this.failStage("token",e);throw e;}
    if(this.stopped||generation!==this.connectionGeneration)throw new Error("warm_connect_cancelled");
    const setup=JSON.parse(JSON.stringify(bundle.setup||{}));
    setup.sessionResumption=resume&&this.resumeHandle?{handle:this.resumeHandle}:{};
    setup.contextWindowCompression={slidingWindow:{}};
    this.stage="websocket";
    const url=PROVIDER_URL+"?access_token="+encodeURIComponent(bundle.token);
    await new Promise<void>((resolve,reject)=>{
      this.trace("t04");
      const ws=new this.WebSocketImpl(url);
      this.provider=ws;this.providerReady=false;let opened=false;let settled=false;
      const fail=(stage:string,error:any)=>{
        if(settled)return;settled=true;if(this.setupTimer)clearTimeout(this.setupTimer);this.setupTimer=null;
        this.failStage(stage,error);try{ws.close();}catch{};reject(error instanceof Error?error:new Error(String(error)));
      };
      this.setupTimer=setTimeout(()=>fail("setup_timeout",new Error("gemini_live_setup_timeout")),SETUP_TIMEOUT_MS).unref();
      ws.on("open",()=>{if(this.provider!==ws||generation!==this.connectionGeneration)return;opened=true;this.trace("t05");this.connectedAt=this.now();this.stage="setup";ws.send(JSON.stringify({setup}));this.trace("t06");});
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
        this.trackLegacyProvider(m);
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
      this.trackLegacyClient(m);
    }catch{if(version2){_client.close(1008,"invalid_voice_message");return;}}
    if(this.providerReady&&this.provider?.readyState===WebSocket.OPEN)this.provider.send(raw);
  }

  private trackLegacyClient(m:any){
    if(m?.realtimeInput?.activityStart||m?.clientContent?.turnComplete===true)this.legacyOpenTurn=true;
    for(const r of m?.toolResponse?.functionResponses||[])this.legacyPendingTools.delete(String(r?.id||""));
  }
  private trackLegacyProvider(m:any){
    for(const c of m?.toolCall?.functionCalls||[])if(this.legacyPendingTools.size<64)this.legacyPendingTools.add(String(c?.id||""));
    for(const id of m?.toolCallCancellation?.ids||[])this.legacyPendingTools.delete(String(id));
    if(m?.serverContent?.turnComplete===true)this.legacyOpenTurn=false;
  }
  private broadcast(raw:string){
    for(const c of this.localClients)if(c.readyState===WebSocket.OPEN) {
      const protocol=this.protocols.get(c);
      if(protocol) {try{protocol.provider(JSON.parse(raw));}catch{c.close(1011,"voice_protocol_error");}}
      else c.send(raw);
    }
  }
  sessionLocale(){return this.locale;}
  executeVoiceCapability(meta:any,request:string,run:()=>Promise<any>):Promise<any> {
    const entry=[...this.protocols.values()].find(p=>p.sessionEpoch===meta?.sessionEpoch&&p.connectionEpoch===meta?.connectionEpoch);
    if(!entry)throw Object.assign(new Error("voice_session_not_owned"),{statusCode:409});
    const turnId=String(meta?.turnId||"");
    return entry.execute(turnId,request,()=>entry.measureCapability(turnId,run));
  }
  measureVoiceDecision(request:string,run:()=>Promise<any>):Promise<any> {
    const matches=[...this.protocols.values()].map(protocol=>({protocol,turnId:protocol.matchingFinalRequest(request)})).filter(row=>row.turnId!==null);
    if(matches.length!==1)return run();
    return matches[0].protocol.measureDecision(matches[0].turnId!,run);
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
    const p=this.provider;this.provider=null;this.providerReady=false;this.legacyOpenTurn=false;this.legacyPendingTools.clear();
    if(!preserveResume){this.resumeHandle="";this.resumeHandleAt=0;this.historyLoaded=false;this.conversationId="";this.understanding.clear();}
    this.state="cold";this.stage=preserveResume&&this.hasValidResumeHandle()?"resumable_idle":"idle";this.resumedLast=false;this.reconnectAttempts=0;
    try{p?.close();}catch{}
  }
  cool(reason="manual",preserveResume=false){this.resetProvider(reason,preserveResume);}
  shutdown(){this.stopped=true;if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=null;this.releaseDetachWaiters();this.cool("shutdown",false);for(const c of this.localClients)try{c.close(1001,"shutdown");}catch{}this.localClients.clear();}
}

export const clawLiveWarmCore=new ClawLiveWarmCore();
export function attachClawLiveWarmUpgrade(server:http.Server,core=clawLiveWarmCore){
  const localServer=new WebSocketServer({noServer:true,maxPayload:2*1024*1024});
  localServer.on("connection",(ws,req)=>{void core.attach(ws,safeMeta(req)).catch((error:any)=>ws.close(1008,error?.message==="unknown_voice"?"unknown_voice":"warm_unavailable"));});
  server.once("close",()=>localServer.close());
  server.on("upgrade",(req: http.IncomingMessage,socket:Duplex,head:Buffer)=>{
    let pathname="";try{pathname=new URL(req.url||"/","http://127.0.0.1").pathname;}catch{}
    if(pathname!==SOCKET_PATH||!loopback(req.socket.remoteAddress)||req.headers.origin){socket.destroy();return;}
    try {safeMeta(req);} catch {const body=JSON.stringify({success:false,error:"unknown_voice"});socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: "+Buffer.byteLength(body)+"\r\n\r\n"+body);return;}
    localServer.handleUpgrade(req,socket,head,(ws)=>localServer.emit("connection",ws,req));
  });
}

export function clawLiveWarmMeta(body:any):LocalMeta{
  const locale=String(body?.locale||"fr").slice(0,32);const client=String(body?.client||"samantha_android").replace(/[^A-Za-z0-9._-]/g,"").slice(0,64)||"samantha_android";
  const raw=String(body?.sessionId||body?.session||"default");const sessionId=/^[A-Za-z0-9._:-]{1,160}$/.test(raw)?raw:"default";return {voice:validatedClawLiveVoice(body?.voice),locale,client,sessionId};
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
