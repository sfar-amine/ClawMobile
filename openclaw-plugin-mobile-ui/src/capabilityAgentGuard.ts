/** before_tool_call boundary for the brain's typed `samantha_*` tools.
 *
 * The hook never resolves nor decides a route (no second router). It records the current SDK invocation
 * (host turn identity, frozen arguments) that the typed tool consumes exactly once. The free-text
 * `clawmobile_capability` tool is no longer registered (ADR 02/11 brain everywhere, step 3).
 */
import {createHash} from 'node:crypto';
import {dialogueRequestText} from './dialogueSurface';
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
type TypedProof={at:number;tool:string;runId:string;sessionKey:string;sessionId?:string;args:string;
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
 if(!plainRecord(params)||Object.keys(params).length!==3||
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
    return undefined;
  } catch {
    // Descriptor/prototype inspection of a malformed object must also fail closed.
    return refused();
  }
}
