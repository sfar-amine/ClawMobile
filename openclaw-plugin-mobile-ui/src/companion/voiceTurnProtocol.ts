import {createHash} from "crypto";

/** Ephemeral protocol state inside the existing Warm owner. No execution, persistence or retry engine. */
export class VoiceTurnProtocol {
  private sequence=0;
  private turns=new Map<string,Turn>();
  private operations=new Map<string,{hash:string;reply:any}>();
  private asrOwner:string|null=null;
  private outputOwner:string|null=null;
  private nextOutput:string|null=null;
  private waiting:Start|null=null;
  private toolOwners=new Map<string,string>();
  private ambiguous=false;
  private closed=false;
  private pendingTools=new Map<string,any[]>();
  private executions=new Map<string,{request:string;promise:Promise<any>;result?:any}>();
  constructor(readonly connectionEpoch:number, readonly sessionEpoch:string,
    private readonly forward:(value:any)=>void, private readonly emit:(value:any)=>void) {}

  private event(payload:any,turnId:string|null,outputGenerationId:string|null=null,correlation="exact") {
    this.emit({warmEvent:{version:2,connectionEpoch:this.connectionEpoch,sessionEpoch:this.sessionEpoch,
      sequence:++this.sequence,turnId,outputGenerationId,correlation,payload}});
  }
  private error(code:string) {this.event({protocolError:{code}},null,null,"ambiguous");}
  private requireId(v:any):string {
    if(typeof v!=="string"||!ID.test(v))throw new Error("invalid_identifier");return v;
  }
  receive(value:any) {
    try {
      if(this.ambiguous)throw new Error("transcription_correlation_unavailable");
      if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("invalid_message");
      if(value.warmInput?.audio) {this.audio(value.warmInput.audio);return;}
      const control=value.warmControl;
      if(control?.turnStart||control?.turnEnd||control?.transcriptFinal||control?.interrupt) {
        const names=["turnStart","turnEnd","transcriptFinal","interrupt"].filter(k=>control[k]);
        if(names.length!==1)throw new Error("one_control_required");
        const kind=names[0],body=control[kind];const op=this.requireId(body.operationId);
        if(body.sessionEpoch!==this.sessionEpoch)throw new Error("stale_session");
        const hash=digest(JSON.stringify(value));const old=this.operations.get(op);
        if(old) {if(old.hash!==hash)throw new Error("operation_identity_conflict");this.emit(old.reply);return;}
        if(this.operations.size>=512)throw new Error("session_operation_budget");
        let state="accepted";
        if(kind==="turnStart")state=this.start(body);
        else if(kind==="turnEnd")this.end(body);
        else if(kind==="transcriptFinal")this.transcriptFinal(body);
        else this.interrupt(body);
        const reply={warmAck:{version:2,operationId:op,state,connectionEpoch:this.connectionEpoch,sessionEpoch:this.sessionEpoch}};
        this.operations.set(op,{hash,reply});this.emit(reply);return;
      }
      if(control?.receiptReply) {this.receiptReply(this.requireId(control.receiptReply.turnId));return;}
      if(value.toolResponse) {this.toolResponse(value.toolResponse);return;}
      // A v2 client may load historical content, but cannot forge provider activities or trigger an uncorrelated generation.
      if(value.clientContent?.turnComplete===false && this.turns.size===0) {this.forward(value);return;}
      throw new Error("unsupported_v2_message");
    } catch(e:any) {this.ambiguous=true;this.error(String(e?.message||"protocol_error"));}
  }
  private start(body:any):string {
    const id=this.requireId(body.turnId);const first=body.firstSample;
    if(!Number.isSafeInteger(first)||first<0)throw new Error("invalid_sample_index");
    if(this.ambiguous)throw new Error("transcription_correlation_unavailable");
    if(this.turns.has(id)||this.waiting?.id===id)throw new Error("turn_identity_conflict");
    if(this.turns.size>=64)throw new Error("session_turn_budget");
    if(this.waiting)throw new Error("input_already_waiting");
    const request:Start={id,first,activityStarted:false};
    if(this.asrOwner) {this.waiting=request;return "waiting_for_transcription_boundary";}
    const activeOutput=this.outputOwner?this.turns.get(this.outputOwner):null;
    if(activeOutput&&!activeOutput.outputEnded) {
      if(this.waiting||this.nextOutput)throw new Error("input_already_waiting");
      activeOutput.interrupted=true;this.nextOutput=id;request.activityStarted=true;this.waiting=request;
      this.forward({realtimeInput:{activityStart:{}}});
      this.event({turnPending:{turnId:id,firstSample:first,reason:"output_boundary"}},id,"out-"+id);
      return "waiting_for_output_boundary";
    }
    this.admit(request);return "accepted";
  }
  private admit(request:Start) {
    const t:Turn={id:request.id,end:request.first,inputEnded:false,asrFinished:false,outputEnded:false,
      interrupted:false,generation:"out-"+request.id,audio:new Map(),input:""};
    this.turns.set(t.id,t);this.asrOwner=t.id;this.outputOwner=t.id;
    if(!request.activityStarted)this.forward({realtimeInput:{activityStart:{}}});
    this.event({turnAdmitted:{turnId:t.id,firstSample:request.first}},t.id,t.generation);
  }
  private audio(body:any) {
    if(body.sessionEpoch!==this.sessionEpoch)throw new Error("stale_session");
    const t=this.turns.get(this.requireId(body.turnId));
    if(!t||t.id!==this.asrOwner||t.inputEnded)throw new Error("inactive_input_turn");
    if(body.sampleRate!==16000||!Number.isSafeInteger(body.firstSample)||!Number.isInteger(body.samples)||body.samples<1||body.samples>8000)
      throw new Error("invalid_audio_frame");
    if(typeof body.data!=="string"||body.data.length>22000||!BASE64.test(body.data))throw new Error("invalid_pcm_encoding");
    const bytes=Buffer.from(body.data,"base64");
    if(bytes.length!==body.samples*2)throw new Error("invalid_pcm_length");
    const hash=digest(bytes),old=t.audio.get(body.firstSample);
    if(old) {if(old!==hash)throw new Error("audio_identity_conflict");return;}
    if(body.firstSample!==t.end)throw new Error("noncontiguous_input");
    // Exact retries in the latest ~8 seconds can be recognized; older input is rejected, never replayed.
    t.audio.set(body.firstSample,hash);if(t.audio.size>256)t.audio.delete(t.audio.keys().next().value!);
    t.end+=body.samples;
    this.forward({realtimeInput:{audio:{data:body.data,mimeType:"audio/pcm;rate=16000"}}});
  }
  private end(body:any) {
    const t=this.turns.get(this.requireId(body.turnId));
    if(!t||t.id!==this.asrOwner||t.inputEnded||body.lastSampleExclusive!==t.end)throw new Error("invalid_turn_end");
    t.inputEnded=true;this.forward({realtimeInput:{activityEnd:{}}});
  }
  private transcriptFinal(body:any) {
    const t=this.turns.get(this.requireId(body.turnId));
    if(!t||t.id!==this.asrOwner||!t.inputEnded||t.asrFinished)throw new Error("invalid_transcript_final");
    if(body.source!=="android_speech_service"||typeof body.text!=="string")throw new Error("invalid_transcript_source");
    const text=body.text.trim();
    if(!text||text.length>12000)throw new Error("invalid_transcript_text");
    t.input=text;t.asrFinished=true;this.asrOwner=null;
    this.event({inputFinal:{text:t.input,source:"android_speech_service"}},t.id,t.generation);
    if(!t.interrupted)for(const calls of this.pendingTools.get(t.id)||[])this.event({toolCall:{functionCalls:calls}},t.id,t.generation);
    this.pendingTools.delete(t.id);
    if(this.waiting&&!this.nextOutput&&!this.ambiguous) {
      const pending=this.waiting;this.waiting=null;
      const activeOutput=this.outputOwner?this.turns.get(this.outputOwner):null;
      if(activeOutput&&!activeOutput.outputEnded) {
        activeOutput.interrupted=true;this.nextOutput=pending.id;pending.activityStarted=true;this.waiting=pending;
        this.forward({realtimeInput:{activityStart:{}}});
        this.event({turnPending:{turnId:pending.id,firstSample:pending.first,reason:"output_boundary"}},pending.id,"out-"+pending.id);
      } else this.admit(pending);
    }
  }
  private interrupt(body:any) {
    const t=this.turns.get(this.requireId(body.turnId));
    if(!t||body.outputGenerationId!==t.generation)throw new Error("invalid_output_generation");
    t.interrupted=true;this.pendingTools.delete(t.id);
    this.event({outputInvalidated:{reason:"owner_interruption"}},t.id,t.generation);
    // activityStart on the new input is the provider interruption; this control never cancels a business execution.
  }
  private toolResponse(body:any) {
    const replies=body.functionResponses;
    if(!Array.isArray(replies)||replies.length>16)throw new Error("invalid_tool_response");
    const accepted=[];
    for(const reply of replies) {
      const owner=this.toolOwners.get(reply.id),t=owner?this.turns.get(owner):null;
      if(!t||!t.asrFinished)throw new Error("uncorrelated_tool_response");
      if(t.interrupted)continue; // Original Claw receipt persists independently; never speak the old result into a new turn.
      accepted.push(reply);
    }
    if(accepted.length)this.forward({toolResponse:{functionResponses:accepted}});
  }
  provider(value:any) {
    if(this.ambiguous)return;
    const content=value.serverContent;
    const transcriptOwner=this.asrOwner?this.turns.get(this.asrOwner):null;
    if(content?.inputTranscription) {
      if(transcriptOwner&&!transcriptOwner.asrFinished)
        this.event({serverContent:{inputTranscription:content.inputTranscription}},transcriptOwner.id,transcriptOwner.generation);
      else this.event({lateInputTranscriptionIgnored:{}},null,null,"stale_ignored");
    }
    const id=this.outputOwner,t=id?this.turns.get(id):null;
    if(value.toolCall?.functionCalls) {
      if(!t) {this.error("unowned_tool_call");return;}
      const calls=value.toolCall.functionCalls;
      if(!Array.isArray(calls)||calls.length>16) {this.error("tool_call_budget");return;}
      for(const call of calls) {if(typeof call.id!=="string"||this.toolOwners.size>=128){this.error("tool_call_budget");return;}this.toolOwners.set(call.id,t.id);}
      if(!t.interrupted) {
        if(t.asrFinished)this.event(value,t.id,t.generation);
        else {const pending=this.pendingTools.get(t.id)||[];if(pending.length>=8){this.error("pending_tool_budget");return;}pending.push(calls);this.pendingTools.set(t.id,pending);}
      }
    }
    if(value.toolCallCancellation) {
      for(const cancelled of value.toolCallCancellation.ids||[]) {
        const owner=this.toolOwners.get(cancelled);if(owner)this.event({toolCallCancellation:{ids:[cancelled]}},owner,this.turns.get(owner)?.generation||null);
      }
    }
    if(content) {
      const output={...content};delete output.inputTranscription;
      if(Object.keys(output).length) {
        if(!t) {this.error("unowned_provider_output");return;}
        if(output.interrupted)t.interrupted=true;
        this.event({serverContent:output},t.id,t.generation);
        if(output.interrupted||output.turnComplete) {
          t.outputEnded=true;
          if(this.nextOutput) {
            const next=this.nextOutput;this.nextOutput=null;this.outputOwner=null;
            if(this.waiting?.id===next&&!this.asrOwner){const pending=this.waiting;this.waiting=null;this.admit(pending);}
          }
        }
      }
    } else if(!value.toolCall&&!value.toolCallCancellation) this.event(value,t?.id||null,t?.generation||null);
    if(!this.asrOwner&&this.waiting&&!this.nextOutput&&!this.ambiguous) {const pending=this.waiting;this.waiting=null;this.admit(pending);}
  }
  execute(turnId:string,request:string,run:()=>Promise<any>):Promise<any> {
    const t=this.turns.get(turnId),existing=this.executions.get(turnId);
    const normalized=(v:string)=>v.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
    if(existing) {
      if(existing.request!==request)throw new Error("voice_execution_identity_conflict");
      return existing.promise;
    }
    if(this.closed||this.ambiguous||!t||!t.asrFinished||!t.inputEnded||t.interrupted||normalized(t.input)!==normalized(request))
      throw new Error("voice_execution_not_admissible");
    const entry:{request:string;promise:Promise<any>;result?:any}={request,promise:Promise.resolve(null)};
    this.executions.set(turnId,entry);
    entry.promise=Promise.resolve().then(()=>{if(this.closed||t.interrupted)return {success:false,execution:{state:"cancelled_before_admission"}};return run();}).then(result=>{entry.result=result;return result;});
    return entry.promise;
  }
  receiptReply(turnId:string) {
    const t=this.turns.get(turnId),entry=this.executions.get(turnId);
    if(!t||t.interrupted||!t.outputEnded||!entry?.result)throw new Error("receipt_reply_not_admissible");
    t.outputEnded=false;t.generation="out-"+turnId+"-receipt";this.outputOwner=turnId;
    this.event({outputResumed:{}},turnId,t.generation);
    const instruction="The Claw harness already executed the previous user request. Verified receipt JSON: "+
      JSON.stringify(entry.result).slice(0,48000)+"\nVerbalize only this receipt in the user's language. Do not execute the request again.";
    this.forward({clientContent:{turns:[{role:"user",parts:[{text:instruction}]}],turnComplete:true}});
  }
  close(){this.closed=true;this.waiting=null;this.pendingTools.clear();}
  snapshot(){return {version:2,turns:this.turns.size,asrPending:Boolean(this.asrOwner),inputWaiting:Boolean(this.waiting),ambiguous:this.ambiguous};}
}

type Start={id:string;first:number;activityStarted:boolean};
type Turn={id:string;end:number;inputEnded:boolean;asrFinished:boolean;outputEnded:boolean;interrupted:boolean;generation:string;input:string;audio:Map<number,string>};
const ID=/^[A-Za-z0-9._:-]{1,160}$/;
const BASE64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function digest(value:string|Buffer){return createHash("sha256").update(value).digest("hex");}
