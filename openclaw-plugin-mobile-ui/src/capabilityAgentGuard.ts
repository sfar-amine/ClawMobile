/** 38 E3 — before_tool_call boundary for `clawmobile_capability`.
 *
 * The hook never resolves nor decides a route (no second router). It only:
 *  - copies the model arguments as independent scalars and refuses malformed ones;
 *  - replaces `caller` by the host turn identity (`requester.senderIsOwner`), never the model's.
 * The risk/operator decision is atomic inside the tool: `claw-capability.py agent-execute`
 * resolves once with the canonical Capability Graph, applies the E3 policy and executes exactly
 * that decision with the graph's existing read-only policy (`capability_first_required` otherwise).
 */
import {createHash,randomUUID} from 'node:crypto';
import {dialogueRequestText} from './dialogueSurface';
export const TYPED_CONTROL_ADMISSION_METHOD='samantha.typed-control.admission';
const typedSeal=Symbol('typed-host-invocation');
export type AgentCapabilityHookContext = { requester?: { senderIsOwner?: unknown }; runId?: string; sessionKey?: string; sessionId?: string; toolCallId?: string; agentId?: string };
export type AgentCapabilityHookEvent = { toolName?: unknown; params?: unknown; toolCallId?: string };
export type AgentCapabilityHookResult = { params?: Record<string, unknown>; block?: boolean; blockReason?: string };

export const AGENT_CAPABILITY_REFUSAL = "capability_first_required";

// Current-invocation proof of the existing guard, not a business registry. A
// tool cannot receive this through model arguments, persisted JSON or replay.
type TypedProof={at:number;tool:string;runId:string;sessionKey:string;sessionId?:string;args:string;
  control?:{operationId:string;paramsHash:string;expiresAt:number;assertCurrent:()=>void};
  nativePulse?:{admission:import('./nativePulseAdmission').NativePulseContact;event:Record<string,unknown>;expiresAt:number}};
const typedInvocations = new Map<string, TypedProof>();
const typedId = /^[A-Za-z0-9_.:-]{1,200}$/;
const typedName = /^samantha_[a-z0-9_]{1,100}$/;
function invocationArgs(value: unknown, depth = 0): unknown {
  if (depth > 16) throw Error();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(v => invocationArgs(v, depth + 1));
  if (!plainRecord(value)) throw Error();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) throw Error();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw Error();
    result[key] = invocationArgs(descriptor.value, depth + 1);
  }
  return result;
}
export function consumeTypedInvocation(callId: unknown, tool: string, args: unknown, context: {
  senderIsOwner?: boolean; sessionKey?: string; sessionId?: string; assertInvocationCurrent?: () => void;
}) {
  if (typeof callId !== "string") throw Error("typed_host_admission_required");
  const proof = typedInvocations.get(callId);
  typedInvocations.delete(callId); // One execute only, including a refused invocation.
  if (!proof || Date.now() < proof.at || Date.now() - proof.at > 120000 || proof.tool !== tool || context.senderIsOwner !== true ||
      !context.sessionKey || context.sessionKey !== proof.sessionKey ||
      context.sessionId && context.sessionId !== proof.sessionId || typeof context.assertInvocationCurrent !== "function" ||
      JSON.stringify(invocationArgs(args)) !== proof.args) throw Error("typed_host_admission_required");
  context.assertInvocationCurrent();
  return {owner: true, conversationKey: proof.sessionKey, userRunId: proof.runId, invocationId: callId,[typedSeal]:proof};
}

/** Keep only this already-admitted SDK callback alive while Companion owns the effect/receipt. */
export function holdTypedControlInvocation(bound:any,args:any,context:{senderIsOwner?:boolean;agentId?:string;sessionKey?:string;assertInvocationCurrent?:()=>void},rawBody:string){
 const proof=bound?.[typedSeal] as TypedProof|undefined;
 if(!proof||proof.tool!=='samantha_app'||typedInvocations.has(bound.invocationId)||context.senderIsOwner!==true||context.agentId!=='main'||
    context.sessionKey!==proof.sessionKey||typeof context.assertInvocationCurrent!=='function'||
    JSON.stringify(invocationArgs(args))!==proof.args||args?.action!=='samantha.app.conversation.interrupt')throw Error('typed_host_admission_required');
 const body=JSON.parse(rawBody),sdk=body?.sdk;
 const operationId='typed-stop-'+createHash('sha256').update(JSON.stringify([proof.runId,args.params.conversationId,args.params.runId])).digest('hex');
 if(!body||Object.keys(body).length!==3||body.operationId!==operationId||body.runId!==args.params.runId||
    !sdk||Object.keys(sdk).length!==3||sdk.invocationId!==bound.invocationId||sdk.sessionKey!==proof.sessionKey||sdk.currentRunId!==proof.runId)
  throw Error('typed_host_admission_required');
 context.assertInvocationCurrent();
 const control={operationId,paramsHash:createHash('sha256').update(rawBody).digest('hex'),expiresAt:Math.min(proof.at+120000,Date.now()+30000),assertCurrent:()=>{
   if(context.senderIsOwner!==true||context.agentId!=='main'||context.sessionKey!==proof.sessionKey)throw Error('typed_host_admission_required');
   context.assertInvocationCurrent!();
 }};
 const held={...proof,control};typedInvocations.set(bound.invocationId,held);
 return ()=>{if(typedInvocations.get(bound.invocationId)===held)typedInvocations.delete(bound.invocationId);};
}

export function typedControlAdmission(params:any){
 if(process.env.SAMANTHA_BRAIN_ONLY!=='1'||!plainRecord(params)||Object.keys(params).length!==3||
    typeof params.invocationId!=='string'||typeof params.operationId!=='string'||typeof params.paramsHash!=='string')throw Error('typed_host_admission_required');
 const proof=typedInvocations.get(params.invocationId),control=proof?.control;
 if(!control||Date.now()<proof!.at||Date.now()>=control.expiresAt||params.operationId!==control.operationId||params.paramsHash!==control.paramsHash)
  throw Error('typed_host_admission_required');
 control.assertCurrent();
 return {version:1,invocationId:params.invocationId,operationId:control.operationId,paramsHash:control.paramsHash,expiresAt:control.expiresAt};
}
export async function typedControlAdmissionHandler({params,respond}:any){
 try{return respond(true,typedControlAdmission(params));}
 catch{return respond(false,undefined,{code:'FORBIDDEN',message:'current SDK invocation proof required'});}
}

/** Existing native Pulse admission only; no JSON purpose/caller bit can mint this lease. */
export async function holdNativePulseInterpretation(admission:import('./nativePulseAdmission').NativePulseContact,event:Record<string,unknown>,text:string){
 const {NativePulseContact}=await import('./nativePulseAdmission');
 if(!(admission instanceof NativePulseContact))throw Error('native_pulse_admission_required');
 const packet=await admission.packet(event,text),at=Date.now();
 for(const [key,proof] of typedInvocations)if(at-proof.at>120000)typedInvocations.delete(key);
 if(typedInvocations.size>=256)throw Error('native_pulse_admission_required');
 const id='native-pulse-'+randomUUID(),held:TypedProof={at,tool:'native-pulse-interpretation',runId:admission.eventRef,
  sessionKey:admission.sessionKey,args:'',nativePulse:{admission,event:{surface:event.surface,conversationKey:event.conversationKey,eventRef:event.eventRef,
   ...(admission.requestContext?{requestContext:admission.requestContext}:{})},
   expiresAt:Math.min(packet.valid_until,at+30000)}};
 typedInvocations.set(id,held);
 return {invocationId:id,release:()=>{if(typedInvocations.get(id)===held)typedInvocations.delete(id);}};
}
export async function requireNativePulseInterpretation(params:any){
 const id=params?.nativePulseInvocationId,proof=typeof id==='string'?typedInvocations.get(id):undefined,native=proof?.nativePulse;
 if(!native||Date.now()<proof!.at||Date.now()>=native.expiresAt||typeof params?.message!=='string'||!params.message.startsWith('REQUEST='))
  throw Error('native_pulse_admission_required');
 await native.admission.packet(native.event,native.admission.originalText);
 if(Date.now()>=native.expiresAt)throw Error('native_pulse_admission_required');
 const request=JSON.parse(params.message.slice(8));
 const hash=(parts:unknown[],length:number)=>createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,length);
 const conversation='conv-'+hash(['dialogue-conversation-v1','pulse_room',native.admission.conversationKey.trim()],24);
 const event='evt-'+hash(['dialogue-event-v1','pulse_room',conversation,native.admission.eventRef.trim()],32);
 // The model view deliberately omits host identities. Its message ref is
 // bound here; Python's sealed professional owner separately checks the full projection.
 if(request.message?.ref!==event||request.message?.text!==dialogueRequestText(native.admission.originalText,native.admission.requestContext)||request.message?.provenance!=='server_verified'||
    !Array.isArray(request.catalogue?.domains)||request.catalogue.domains.length!==1||request.catalogue.domains[0]?.domain_id!=='pulse')
  throw Error('native_pulse_admission_required');
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(value: unknown, name: string): unknown {
  if (!plainRecord(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** JSON tool arguments are flat scalar fields. Never retain mutable nested references. */
function scalarSnapshot(value: unknown): Record<string, unknown> | null {
  if (!plainRecord(value)) return null;
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    const field = descriptor.value;
    if (field !== null && field !== undefined && !["string", "boolean", "number"].includes(typeof field)) return null;
    if (typeof field === "number" && !Number.isFinite(field)) return null;
    if (descriptor.enumerable) snapshot[key] = field;
  }
  return snapshot;
}

export function agentCapabilityHook(
  event: AgentCapabilityHookEvent,
  context: AgentCapabilityHookContext,
): AgentCapabilityHookResult | undefined {
  const refused = (): AgentCapabilityHookResult => ({ block: true, blockReason: AGENT_CAPABILITY_REFUSAL });
  try {
    const toolName = ownData(event, "toolName");
    if (typeof toolName !== "string") return refused();
    if (typedName.test(toolName)) {
      const callId = ownData(event, "toolCallId") ?? ownData(context, "toolCallId");
      const runId = ownData(context, "runId"), sessionKey = ownData(context, "sessionKey");
      if (ownData(ownData(context, "requester"), "senderIsOwner") !== true ||
          typeof callId !== "string" || !typedId.test(callId) || typeof runId !== "string" || !typedId.test(runId) ||
          typeof sessionKey !== "string" || !sessionKey || sessionKey.length > 512 ||
          ownData(context, "agentId") && ownData(context, "agentId") !== "main") return refused();
      const at = Date.now();
      for (const [id, proof] of typedInvocations) if (at - proof.at > 120000) typedInvocations.delete(id);
      if (typedInvocations.has(callId)) { typedInvocations.delete(callId); return refused(); }
      if (typedInvocations.size >= 256) return refused();
      const params = invocationArgs(ownData(event, "params")) as Record<string, unknown>;
      const encoded = JSON.stringify(params);
      if (encoded.length > 32768) return refused();
      typedInvocations.set(callId, {at, tool: toolName, runId, sessionKey,
        sessionId: typeof ownData(context, "sessionId") === "string" ? ownData(context, "sessionId") as string : undefined,
        args: encoded});
      return {params};
    }
    if (toolName !== "clawmobile_capability") return undefined;
    const params = scalarSnapshot(ownData(event, "params"));
    if (!params || typeof params.request !== "string" || !params.request.trim() || params.request.length > 12000) return refused();
    // The model never supplies authority: drop its caller, then use the host turn identity when present.
    const { caller: _modelCaller, ...rest } = params;
    const owner = ownData(ownData(context, "requester"), "senderIsOwner");
    const next: Record<string, unknown> = { ...rest };
    if (typeof owner === "boolean") next.caller = owner ? "owner" : "other";
    return { params: next };
  } catch {
    // Descriptor/prototype inspection of a malformed object must also fail closed.
    return refused();
  }
}
