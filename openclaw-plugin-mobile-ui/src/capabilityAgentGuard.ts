/** 38 E3 — before_tool_call boundary for `clawmobile_capability`.
 *
 * The hook never resolves nor decides a route (no second router). It only:
 *  - copies the model arguments as independent scalars and refuses malformed ones;
 *  - replaces `caller` by the host turn identity (`requester.senderIsOwner`), never the model's.
 * The risk/operator decision is atomic inside the tool: `claw-capability.py agent-execute`
 * resolves once with the canonical Capability Graph, applies the E3 policy and executes exactly
 * that decision with the graph's existing read-only policy (`capability_first_required` otherwise).
 */
import {createHash} from 'node:crypto';
import {dialogueRequestText} from './dialogueSurface';
import {contactRoomPrincipal,contactRoomSession,ROOM_TOOLS,toolRoom} from './contactRoomProfile';
export const TYPED_CONTROL_ADMISSION_METHOD='samantha.typed-control.admission';
// OpenClaw 2026.10.9 loads this plugin several times in one Gateway process (one copy per plugin build of its
// capture: S24 02/11 10:24, three copies of openclaw-plugin-mobile-ui). The before_tool_call hook and the tool execute
// can come from different copies, so the proof and its seal are process-wide (Symbol.for), never module-private:
// a per-module Map refused every typed call (typed_host_admission_required) whenever the copies differed.
const typedSeal=Symbol.for('samantha.typed-host-invocation.v1');
export type AgentCapabilityHookContext = { requester?: { senderIsOwner?: unknown }; runId?: string; sessionKey?: string; sessionId?: string; toolCallId?: string; agentId?: string };
export type AgentCapabilityHookEvent = { toolName?: unknown; params?: unknown; toolCallId?: string };
export type AgentCapabilityHookResult = { params?: Record<string, unknown>; block?: boolean; blockReason?: string };

export const AGENT_CAPABILITY_REFUSAL = "capability_first_required";

// Current-invocation proof of the existing guard, not a business registry. A
// tool cannot receive this through model arguments, persisted JSON or replay.
// principal: « owner » for the owner's main agent, « room:<pièce>:wa-… » for a room contact. One never
// consumes the other's proof (consumeTypedInvocation / consumeRoomInvocation).
type TypedProof={at:number;tool:string;runId:string;sessionKey:string;sessionId?:string;args:string;principal:string;
  control?:{operationId:string;paramsHash:string;expiresAt:number;assertCurrent:()=>void};};
const TYPED_REGISTRY=Symbol.for('samantha.typed-invocations.v1');
function typedRegistry(): Map<string, TypedProof> {
  const holder = globalThis as any;
  const existing = Object.getOwnPropertyDescriptor(holder, TYPED_REGISTRY)?.value;
  if (existing instanceof Map) return existing as Map<string, TypedProof>;
  const created = new Map<string, TypedProof>();
  // Defined once for the process, neither replaceable nor enumerable; every copy of this module shares it.
  Object.defineProperty(holder, TYPED_REGISTRY, {value: created, writable: false, configurable: false, enumerable: false});
  return created;
}
const typedInvocations = typedRegistry();
// S24 30/10 23:57: a direct (catalogMode "direct-only") call keeps the provider's Responses id `call_<hex>|fc_<hex>`;
// refusing `|` blocked every direct samantha_* call. The id stays an opaque Map key of this invocation only.
const typedId = /^[A-Za-z0-9_.:|-]{1,200}$/;
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
  if (!proof || proof.principal !== "owner" || Date.now() < proof.at || Date.now() - proof.at > 120000 || proof.tool !== tool || context.senderIsOwner !== true ||
      !context.sessionKey || context.sessionKey !== proof.sessionKey ||
      context.sessionId && context.sessionId !== proof.sessionId || typeof context.assertInvocationCurrent !== "function" ||
      JSON.stringify(invocationArgs(args)) !== proof.args) throw Error("typed_host_admission_required");
  context.assertInvocationCurrent();
  return {owner: true, conversationKey: proof.sessionKey, userRunId: proof.runId, invocationId: callId,[typedSeal]:proof};
}

/** The Pulse room's tool (Amine 02/11); every room's typed tool is in ROOM_TOOLS (contactRoomProfile ROOM_TYPED). */
export const PULSE_ROOM_TOOLS: ReadonlySet<string> = new Set(["samantha_pulse"]);
export {ROOM_TOOLS};

/** The room principal of one room tool in this contact session: the tool's room must be one of the session's. */
export function roomToolPrincipal(agentId: unknown, sessionKey: unknown, tool: unknown) {
  const room = toolRoom(tool);
  return room ? contactRoomPrincipal(agentId, sessionKey, room) : null;
}

/**
 * The room contact's counterpart of consumeTypedInvocation: the current SDK invocation of THIS room session, admitted
 * by before_tool_call for the same contact principal (same room). An owner proof never satisfies it, and its proof
 * never satisfies the owner's. Authority is still the room grant, re-read by the room tool (roomBrain).
 */
export function consumeRoomInvocation(callId: unknown, tool: string, args: unknown, context: {
  senderIsOwner?: boolean; agentId?: string; sessionKey?: string; sessionId?: string; assertInvocationCurrent?: () => void;
}) {
  if (typeof callId !== "string") throw Error("typed_host_admission_required");
  const proof = typedInvocations.get(callId);
  typedInvocations.delete(callId);
  const room = roomToolPrincipal(context?.agentId, context?.sessionKey, tool);
  if (!proof || !room || proof.principal !== room.principal || !ROOM_TOOLS.has(tool) || proof.tool !== tool ||
      Date.now() < proof.at || Date.now() - proof.at > 120000 || context.senderIsOwner === true ||
      context.sessionKey !== proof.sessionKey || context.sessionId && context.sessionId !== proof.sessionId ||
      typeof context.assertInvocationCurrent !== "function" || JSON.stringify(invocationArgs(args)) !== proof.args)
    throw Error("typed_host_admission_required");
  context.assertInvocationCurrent();
  return {owner: false as const, principal: room.principal, room, conversationKey: room.conversationKey,
    userRunId: proof.runId, invocationId: callId};
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
      const senderIsOwner = ownData(ownData(context, "requester"), "senderIsOwner");
      // A room contact's own session: only the typed tools of its rooms, never as the owner (Amine 02/11). Any
      // contact session (rooms or not) never reaches the owner's tools.
      const room = roomToolPrincipal(ownData(context, "agentId"), sessionKey, toolName);
      if (room || contactRoomSession(sessionKey) ? !room || senderIsOwner === true :
          senderIsOwner !== true || ownData(context, "agentId") && ownData(context, "agentId") !== "main") return refused();
      if (typeof callId !== "string" || !typedId.test(callId) || typeof runId !== "string" || !typedId.test(runId) ||
          typeof sessionKey !== "string" || !sessionKey || sessionKey.length > 512) return refused();
      const at = Date.now();
      for (const [id, proof] of typedInvocations) if (at - proof.at > 120000) typedInvocations.delete(id);
      if (typedInvocations.has(callId)) { typedInvocations.delete(callId); return refused(); }
      if (typedInvocations.size >= 256) return refused();
      const params = invocationArgs(ownData(event, "params")) as Record<string, unknown>;
      const encoded = JSON.stringify(params);
      if (encoded.length > 32768) return refused();
      typedInvocations.set(callId, {at, tool: toolName, runId, sessionKey, principal: room ? room.principal : "owner",
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
