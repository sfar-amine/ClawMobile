import {recordPresentationDiagnostics} from "./companion/receiptPresentation";
import {runtimeFile} from "./runtimeRoot";
import {createHash} from "node:crypto";
import {authenticatedMcpContextMetadata,submitNativePulseRequest,getRemoteBridgeRequest} from "./companion/remoteBridge";
import {NativePulseContact,NATIVE_PULSE_PROTOCOL} from "./nativePulseAdmission";
import {runCapabilityHelperProcess} from "./companion/capabilityBridge";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { admittedAtMs, dialogueTurn, transportEventRef } from "./dialogueSurface";
import { PUBLIC_WEB_BUDGET_MS } from "./companion/runWeb";

export const INTENT_INPUT_PROTOCOL = "mcp-input.v1";
export const INTENT_READ_PROTOCOL = "mcp-read.v1";
const MAX_MESSAGE_CHARS = 12000;
const LOCAL_COMPANION_SESSION = /^agent:main:companion-chat-[A-Za-z0-9-]{1,96}$/;

export type FastPathResult = {
  status?: string;
  intentInputProtocol?: string;
  intentReadProtocol?: string;
  web?: unknown;
  result?: unknown;
  execution_state?: string;
  text?: string;
  reason?: string;
  /** Sanitized machine class emitted by the deterministic runner. */
  reason_class?: string;
  reasonClass?: string;
  target?: string;
  intent?: string;
  route?: string;
  capability?: string;
  source?: string;
  provenance?: import("./companion/capabilityProvenance").CapabilityProvenance;
  model_bypassed?: boolean;
  decision?: Record<string, unknown>;
  presentation?: unknown;
  understood?: unknown;
  failure?: unknown;
  alternatives?: unknown;
  clarification?: Record<string, unknown>;
  resolution?: Record<string, unknown>;
};

type InboundEvent = {
  id?: string;
  runId?: string;
  idempotencyKey?: string;
  content?: string;
  bodyForAgent?: string;
  isGroup?: boolean;
  senderIsOwner?: boolean;
  media?: unknown[];
  originalMedia?: unknown[];
  sessionKey?: string;
};

type InboundContext = {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  messageProvider?: string;
};

export type RunnerOptions = {
  /** Opaque host admission, available only in the native contacts-pulse hook. */
  nativePulse?: NativePulseContact;
  nativePulseMode?: "prepare"|"execute"|"observe";
  /** Host-private MCP envelope; all enclosed narrative remains client-reported. */
  intentContext?: { request: string; client_context: Record<string, unknown> };
  /** Only the authenticated existing MCP RemoteBridge read callback uses this. */
  intentReadOnly?: boolean;
  /** Opaque admitted relay-frame identity, never serialized or built from caller arguments. */
  intentContextAdmission?: object;
  /** Only the contact ingress owner creates this context; it travels on a private pipe. */
  qaContext?:Record<string,unknown>;
  helperPath?: string;
  home?: string;
  surface?: string;
  caller?: "owner" | "trusted" | "other";
  originId?: string;
  timeoutSeconds?: number;
  /** Host-created transport context. Never sourced from model/public request metadata. */
  requestId?: string;
  runId?: string;
  sessionId?: string;
  remainingBudgetMs?: number;
  deadlineEpochMs?: number;
  signal?: AbortSignal;
  checkOnly?: boolean;
  /** Optional total budget for read-only checks; never valid for dispatch. */
  checkBudgetMs?: number;
  preparedDecision?: Record<string, unknown>;
  clarificationDecision?: Record<string, unknown>;
  clarificationOriginalText?: string;
  /** SAM-MIG V2.2: run the dialogue coordinator in the helper process (`--dialogue <mode>`). */
  dialogue?: DialogueMode;
};

export type DialogueMode = {
  mode: "turn" | "handoff" | "abort" | "preview";
  event?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  goalRef?: string;
  /** Host-created Web context for the hand-off (run, session, 12 s deadline, signed voice delegation). Never from the
   * model or a request body; the coordinator stays the only dialogue owner and receives it as CLI metadata only. */
  web?: DialogueWebContext;
};

export type DialogueWebContext = { runId?: string; sessionId?: string; deadlineEpochMs?: number; voiceDelegation?: boolean };
const WEB_HOST_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
function dialogueWebArgs(web?: DialogueWebContext): string[] {
  if (!web) return [];
  return [
    ...(web.runId && WEB_HOST_ID.test(web.runId) ? ["--run-id", web.runId] : []),
    ...(web.sessionId && WEB_HOST_ID.test(web.sessionId) ? ["--session-id", web.sessionId] : []),
    ...(Number.isSafeInteger(web.deadlineEpochMs) && web.deadlineEpochMs! > Date.now() ? ["--deadline-epoch-ms", String(web.deadlineEpochMs)] : []),
    ...(web.voiceDelegation === true ? ["--voice-delegation"] : []),
  ];
}

function helperCandidates(home = os.homedir()): string[] {
  return [
    process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER || "",
    runtimeFile("model-fast-path.py", home),
  ].filter(Boolean);
}

function isMainSession(event: InboundEvent, ctx: InboundContext): boolean {
  if (ctx.agentId) return ctx.agentId === "main";
  const key = ctx.sessionKey ?? event.sessionKey ?? "";
  return key.startsWith("agent:main:");
}

export function isTrustedLocalCompanionSession(
  event: InboundEvent,
  ctx: InboundContext,
): boolean {
  if (!isMainSession(event, ctx) || event.isGroup === true) return false;
  const key = String(ctx.sessionKey ?? event.sessionKey ?? "");
  if (!LOCAL_COMPANION_SESSION.test(key)) return false;
  const channel = String(ctx.channel || ctx.messageProvider || "").toLowerCase();
  return !channel || channel === "openclaw" || channel === "companion" || channel === "android";
}

export function isOwnerFastPathEligible(
  event: InboundEvent,
  ctx: InboundContext,
): boolean {
  const owner = event.senderIsOwner === true || isTrustedLocalCompanionSession(event, ctx);
  if (!owner || event.isGroup === true) return false;
  if (!isMainSession(event, ctx)) return false;
  if ((event.media?.length ?? 0) > 0 || (event.originalMedia?.length ?? 0) > 0) {
    return false;
  }
  const message = (event.bodyForAgent ?? event.content ?? "").trim();
  return message.length > 0 && message.length <= MAX_MESSAGE_CHARS;
}

function surfaceFor(ctx: InboundContext): string {
  const channel = String(ctx.channel || ctx.messageProvider || "").toLowerCase();
  return channel === "whatsapp" ? "whatsapp" : "claw_live";
}

/** O6 (fichier 37) : a guarded operator read holds Wi-Fi off for at most 60 s; the helper waits up to 70 s for it.
 * An executing call is never killed before that wait (+ 15 s for resolution and process start). Other routes stay
 * bounded by the helper's own budget; a check-only call keeps its short budget. */
export const GUARDED_ENTRY_WAIT_S = 70;
export function fastPathProcessTimeoutMs(timeoutSeconds: number, checkOnly: boolean): number {
  return checkOnly ? (timeoutSeconds + 8) * 1000 : (Math.max(timeoutSeconds, GUARDED_ENTRY_WAIT_S) + 15) * 1000;
}

function canonicalIntentInput(value:any):any {
  if(Array.isArray(value))return value.map(canonicalIntentInput);
  if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalIntentInput(value[key])]));
  return value;
}
function privateIntentPacket(options:RunnerOptions) {
  if(!options.intentContext)return undefined;
  // Reconstruct the two public fields: JSON/extra RunnerOptions keys cannot
  // smuggle a host_context across the otherwise authenticated child channel.
  const input={request:options.intentContext.request,client_context:options.intentContext.client_context};
  const admission=authenticatedMcpContextMetadata(options.intentContextAdmission);
  if(!admission)return input;
  const key=`external_mcp:${admission.client_id}:${options.intentContext.client_context.conversation_ref}`;
  if(options.caller!=="owner"||options.requestId!==admission.request_id||options.dialogue?.event?.eventRef!==admission.request_id||
     options.dialogue?.event?.conversationKey!==key)throw new Error("SHARED_CONTEXT_ACCESS_UNVERIFIED");
  return {...input,host_context:{schema_version:"mcp-host-context.v1",...admission,
    principal_ref:`mcp:${admission.client_id}`,conversation_key:key,
    verification_ref:`mcp-context:${admission.request_id}`,
    input_digest:createHash("sha256").update(JSON.stringify(canonicalIntentInput(input))).digest("hex")}};
}

async function runNativePulseHandoff(message:string,options:RunnerOptions):Promise<FastPathResult> {
  const prepared:any=await runModelFastPath(message,{...options,nativePulseMode:'prepare'});
  if(prepared.nativePulseProtocol!==NATIVE_PULSE_PROTOCOL||!prepared.request)
    return prepared;
  const request=prepared.request;
  if(!prepared.dispatch_allowed){
    // An unresolved Attempt is observe-only, even if no Bridge receipt exists yet.
    const existing=getRemoteBridgeRequest(request.requestId);
    if(!existing||!['completed','failed'].includes(existing.state))return {
      outcome:'WAITING_OPERATION',reasonCode:'verification_required',handled:true,modelAllowed:false,
      text:'La commande est en cours de vérification. Elle ne sera pas rejouée.'} as any;
  }else{
    await submitNativePulseRequest({...request,stepId:prepared.wire_step_id,continuumFence:prepared.continuum_fence},
      options.nativePulse!,options.dialogue!.event!,message,
      async()=>runModelFastPath(message,{...options,nativePulseMode:'execute'}));
  }
  return runModelFastPath(message,{...options,nativePulseMode:'observe'});
}

export async function runModelFastPath(
  message: string,
  options: RunnerOptions = {},
): Promise<FastPathResult> {
  let nativePacket:Record<string,unknown>|undefined;
  if(options.nativePulseMode&&!options.nativePulse)return {status:'known_error',reason:'native_pulse_admission_required',execution_state:'not_started'};
  if(options.nativePulse){
    try{
      if(!(options.nativePulse instanceof NativePulseContact)||options.surface!=='whatsapp'||options.caller!=='owner'||
         !options.dialogue||options.qaContext||options.intentContext||options.dialogue.policy?.scope!=='pulse_room'||
         options.dialogue.web||options.preparedDecision||options.clarificationDecision||options.intentReadOnly)
        throw Error();
      nativePacket={request:message,admission:await options.nativePulse.packet(options.dialogue.event,message)};
    }catch{return {outcome:'DENIED',reasonCode:'native_pulse_admission_required',handled:true,modelAllowed:false,
      text:'L’accès à la pièce Pulse n’est pas confirmé. Rien n’a été exécuté.'} as any;}
    if(options.dialogue.mode==='handoff'&&!options.nativePulseMode)return runNativePulseHandoff(message,options);
  }
  if (options.intentReadOnly && (!options.intentContext || options.dialogue?.mode !== "preview"))
    return {status:"known_error",reason:"INTERPRETATION_HOST_UNAVAILABLE",execution_state:"not_started"};
  if (options.intentContext && (process.env.SAMANTHA_INTENT_INTERPRETER !== "1" || options.qaContext ||
      options.surface !== "mcp" || !options.dialogue || options.intentContext.request !== message ||
      options.intentContext.client_context.schema_version !== INTENT_INPUT_PROTOCOL ||
      Buffer.byteLength(JSON.stringify(options.intentContext), "utf8") > 32768))
    return {status:"known_error",reason:"INTERPRETATION_HOST_UNAVAILABLE",execution_state:"not_started"};
  let intentPacket:Record<string,unknown>|undefined;
  try{intentPacket=privateIntentPacket(options);}
  catch{return {status:"known_error",reason:"SHARED_CONTEXT_ACCESS_UNVERIFIED",execution_state:"not_started"};}
  if(intentPacket&&Buffer.byteLength(JSON.stringify(intentPacket),"utf8")>32768)
    return {status:"known_error",reason:"INTERPRETATION_HOST_UNAVAILABLE",execution_state:"not_started"};
  if(options.checkBudgetMs!==undefined&&(!options.checkOnly||!Number.isSafeInteger(options.checkBudgetMs)||options.checkBudgetMs<1||options.checkBudgetMs>10000))return {status:"error",reason:"invalid_check_budget"};
  const bounded = options.remainingBudgetMs !== undefined;
  if (bounded && (!Number.isSafeInteger(options.remainingBudgetMs) || options.remainingBudgetMs! < 1 || options.remainingBudgetMs! > PUBLIC_WEB_BUDGET_MS ||
      !Number.isSafeInteger(options.deadlineEpochMs) || options.deadlineEpochMs! <= Date.now() || !options.requestId ||
      options.preparedDecision && options.preparedDecision.requestId !== options.requestId)) return {status:"known_error",reason:"invalid_web_execution_context"};
  if (options.signal?.aborted) return {status:"known_error",reason:"execution_cancelled",execution_state:"cancelled"};
  const started = performance.now();
  // Private QA ingress has already spent up to 3 s reading current authority.
  // All helper candidates share the remaining 11 s, including failed launches.
  const qaDeadline=options.qaContext?started+11000:undefined;
  const deadline=options.checkBudgetMs===undefined?undefined:Date.now()+options.checkBudgetMs;
  const helpers = options.helperPath
    ? [options.helperPath]
    : helperCandidates(options.home);
  let lastError = "helper_missing";
  for (const helper of helpers) {
    const qaRemaining=qaDeadline===undefined?Infinity:Math.floor(qaDeadline-performance.now());
    if(qaRemaining<=0)return {status:"error",reason:"qa_ingress_deadline_exceeded"};
    const remaining = bounded ? Math.floor(Math.min(options.remainingBudgetMs! - (performance.now()-started), options.deadlineEpochMs! - Date.now())) : deadline===undefined?undefined:deadline-Date.now();
    if(remaining!==undefined&&remaining<=0)return {status:bounded?"known_error":"error",reason:bounded?"web_deadline_exceeded":"check_budget_exceeded",...(bounded?{execution_state:"timeout"}:{})};
    try {
      const dialogue = options.dialogue;
      const helperMessage=options.qaContext?'Demande privée de tests auto.':options.intentContext?'Demande MCP privée.':options.nativePulse?'Demande Pulse privée.':message;
      const argv = dialogue ? [
        "--dialogue", dialogue.mode,
        ...(dialogue.goalRef ? ["--goal-ref", dialogue.goalRef] : []),
        ...dialogueWebArgs(dialogue.web),
        "--surface", options.surface || "claw_live",
        "--caller", options.caller || "owner",
        "--origin-id", options.originId || "capability-first",
        "--timeout", String(Math.max(2, Math.min(options.timeoutSeconds || 30, 120))),
        helperMessage,
      ] : [
        ...(options.clarificationDecision ? ["--resolve-clarification"] : options.preparedDecision ? ["--execute-decision"] : []),
        ...(options.checkOnly ? ["--check"] : []),
        "--surface", options.surface || "claw_live",
        "--caller", options.caller || "owner",
        "--origin-id", options.originId || "capability-first",
        "--timeout", String(Math.max(2, Math.min(options.timeoutSeconds || 30, 120))),
        ...(options.requestId ? ["--request-id",options.requestId] : []),
        ...(options.runId ? ["--run-id",options.runId] : []),
        ...(options.sessionId ? ["--session-id",options.sessionId] : []),
        ...(bounded ? ["--remaining-budget-ms",String(remaining),"--deadline-epoch-ms",String(options.deadlineEpochMs)] : []),
        helperMessage,
      ];
      if(options.intentContext&&options.requestId)argv.unshift("--request-id",options.requestId);
      if (options.intentContext) argv.unshift("--intent-context-stdin");
      if(options.nativePulse)argv.unshift("--native-pulse-mode",options.nativePulseMode||"turn");
      if (options.intentReadOnly) argv.unshift("--intent-read-only");
      const timeoutSeconds = Math.max(2, Math.min(options.timeoutSeconds || 30, 120));
      const raw: any = await runCapabilityHelperProcess(
        [helper, ...argv],
        {
          timeoutMs: Math.min(fastPathProcessTimeoutMs(timeoutSeconds, !!options.checkOnly),remaining ?? Infinity,qaRemaining),
          killGroup:bounded||options.checkBudgetMs!==undefined||!!options.qaContext,signal:options.signal,
          maxBuffer: options.qaContext?64*1024:bounded ? 128 * 1024 : 2 * 1024 * 1024,
          ...(options.qaContext?{privateInput:JSON.stringify({context:options.qaContext,user_input:message})}:
            options.intentContext?{privateInput:JSON.stringify(intentPacket)}:
              options.nativePulse?{privateInput:JSON.stringify(nativePacket)}:{}),
          env: {
            ...process.env,
            SAMANTHA_QA_CONTEXT_FD:undefined,
            SAMANTHA_QA_INPUT_FD:options.qaContext?'0':undefined,
            SAMANTHA_INTENT_INPUT_FD:options.intentContext?'0':undefined,
            SAMANTHA_NATIVE_PULSE_FD:options.nativePulse?'0':undefined,
            // Pilot admission is per host request, never a global interception
            // of unrelated app/WhatsApp/Orange/payment requests.
            SAMANTHA_INTENT_INTERPRETER:options.nativePulse?"1":options.intentContext?process.env.SAMANTHA_INTENT_INTERPRETER:undefined,
            ...((options.preparedDecision || options.clarificationDecision) ? {
              CLAW_PREPARED_DECISION_B64: Buffer.from(JSON.stringify(options.preparedDecision || options.clarificationDecision), "utf8").toString("base64"),
            } : {}),
            ...(dialogue ? {
              CLAW_DIALOGUE_EVENT_B64: Buffer.from(JSON.stringify(dialogue.event || {}), "utf8").toString("base64"),
              CLAW_DIALOGUE_POLICY_B64: Buffer.from(JSON.stringify(dialogue.policy || {}), "utf8").toString("base64"),
            } : {}),
            ...(options.clarificationDecision ? {
              CLAW_CLARIFICATION_ORIGINAL_B64: Buffer.from(String(options.clarificationOriginalText || ""), "utf8").toString("base64"),
            } : {}),
          },
        },
      );
      const stdout = typeof raw === "string" ? raw : String(raw?.stdout ?? "");
      const parsed = JSON.parse(stdout || "{}");
      if(qaDeadline!==undefined&&performance.now()>=qaDeadline)return {status:"error",reason:"qa_ingress_deadline_exceeded"};
      if(options.signal?.aborted)return {status:"known_error",reason:"execution_cancelled",execution_state:"cancelled"};
      if(options.checkBudgetMs!==undefined&&performance.now()-started>=options.checkBudgetMs)return {status:"error",reason:"check_budget_exceeded"};
      if(bounded&&(Date.now()>=options.deadlineEpochMs!||performance.now()-started>=options.remainingBudgetMs!))return {status:"known_error",reason:"web_deadline_exceeded",execution_state:"timeout"};
      if(options.nativePulse&&parsed?.nativePulseProtocol!==NATIVE_PULSE_PROTOCOL)
        return {status:"known_error",reason:"native_pulse_protocol_required",execution_state:options.nativePulseMode==='execute'?"verification_required":"not_started"};
      if (options.intentContext && parsed?.intentInputProtocol !== INTENT_INPUT_PROTOCOL)
        return {status:"known_error",reason:"INTERPRETATION_HOST_UNAVAILABLE",execution_state:"not_started"};
      if (options.intentReadOnly && parsed?.intentReadProtocol !== INTENT_READ_PROTOCOL)
        return {status:"known_error",reason:"INTERPRETATION_HOST_UNAVAILABLE",execution_state:"not_started"};
      if(typeof parsed === "object" && parsed !== null)recordPresentationDiagnostics(parsed.presentationDiagnostics);
      return typeof parsed === "object" && parsed !== null
        ? parsed as FastPathResult
        : { status: "error", reason: "invalid_result" };
    } catch (error: any) {
      if(qaDeadline!==undefined&&(performance.now()>=qaDeadline||error?.killed))return {status:"error",reason:"qa_ingress_deadline_exceeded"};
      if (options.signal?.aborted) return {status:"known_error",reason:"execution_cancelled",execution_state:"cancelled"};
      if (bounded && (error?.killed || Date.now()>=options.deadlineEpochMs! || performance.now()-started>=options.remainingBudgetMs!)) return {status:"known_error",reason:"web_deadline_exceeded",execution_state:"timeout"};
      if(deadline!==undefined&&(Date.now()>=deadline||error?.killed))return {status:"error",reason:"check_budget_exceeded"};
      if (error?.code === "ENOENT") {
        lastError = "helper_missing";
        continue;
      }
      const stdout = typeof error?.stdout === "string" ? error.stdout : "";
      try {
        const parsed = JSON.parse(stdout || "{}");
        if (parsed && typeof parsed === "object") {
          if(options.nativePulse&&parsed.nativePulseProtocol!==NATIVE_PULSE_PROTOCOL)
            return {status:"known_error",reason:"native_pulse_execution_unknown",execution_state:"verification_required"};
          if (options.intentContext && parsed.intentInputProtocol !== INTENT_INPUT_PROTOCOL)
            return {status:"known_error",reason:"INTERPRETATION_HOST_UNAVAILABLE",execution_state:"not_started"};
          if (options.intentReadOnly && parsed.intentReadProtocol !== INTENT_READ_PROTOCOL)
            return {status:"known_error",reason:"INTERPRETATION_HOST_UNAVAILABLE",execution_state:"not_started"};
          return parsed as FastPathResult;
        }
      } catch {}
      lastError = "helper_failed";
      break;
    }
  }
  return { status: "error", reason: lastError };
}

function conversationKey(event: InboundEvent, ctx: InboundContext): string {
  return String(ctx.sessionKey || event.sessionKey || ctx.channel || "inbound").slice(0, 240);
}

const OWNER_WHATSAPP_SESSION = /^agent:main:whatsapp:direct:(\+?[1-9][0-9]{7,14})$/;

/** Owner WhatsApp numbers from the Gateway's canonical config (commands.ownerAllowFrom « whatsapp:+… »). */
export function ownerWhatsAppNumbers(configPath = path.join(process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"), "openclaw.json")): Set<string> {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const values: unknown[] = config?.commands?.ownerAllowFrom ?? [];
    return new Set(values.filter((v): v is string => typeof v === "string" && /^whatsapp:\+[1-9][0-9]{7,14}$/.test(v)).map((v) => v.slice(9)));
  } catch {
    return new Set();
  }
}

/**
 * S24 12/10: the Gateway runs inbound_claim only for plugin-bound conversations, so the owner's WhatsApp turns
 * never reached the capability-first path (Amine: « même pour moi il ne faut pas passer par le modèle »).
 * before_dispatch runs for every inbound message but carries no senderIsOwner: the owner is proved by the routed
 * main session key AND the number listed in commands.ownerAllowFrom. WhatsApp only: app turns already run the
 * fast path in the Companion and must never execute twice.
 */
export async function handleOwnerBeforeDispatch(
  event: { messageId?: string; content?: string; body?: string; channel?: string; sessionKey?: string; isGroup?: boolean; timestamp?: number },
  ctx: { messageId?: string; channelId?: string; sessionKey?: string },
  runner: (message: string, options?: RunnerOptions) => Promise<FastPathResult> = runModelFastPath,
  owners: () => Set<string> = ownerWhatsAppNumbers,
): Promise<{ handled: boolean; text?: string }> {
  const sessionKey = String(ctx?.sessionKey ?? event?.sessionKey ?? "");
  const channel = String(event?.channel ?? ctx?.channelId ?? "").toLowerCase();
  const match = OWNER_WHATSAPP_SESSION.exec(sessionKey);
  if (channel !== "whatsapp" || !match || event?.isGroup === true) return { handled: false };
  const number = match[1].startsWith("+") ? match[1] : "+" + match[1];
  if (!owners().has(number)) return { handled: false };
  const out = await handleOwnerFastPath(
    // content is the sender's text; body may carry the channel envelope.
    { content: event?.content || event?.body, senderIsOwner: true, isGroup: false, sessionKey, timestamp: event?.timestamp },
    { agentId: "main", sessionKey, channel: "whatsapp", runId: event?.messageId ?? ctx?.messageId },
    runner,
  );
  return out.handled ? { handled: true, text: out.reply?.text } : { handled: false };
}

/**
 * Owner WhatsApp / plugin-bound turn (SAM-MIG V2.2): one admitted event for the dialogue coordinator, which owns
 * the pending question (no in-process copy here). The reply text goes back as the hook `text`, which OpenClaw
 * delivers through its durable queue (L0: outbound-prepared-v1) — never a direct send from the plugin.
 * Not handled (UNRESOLVED outside a question, D-G): the agent continues as before.
 */
export async function handleOwnerFastPath(
  event: InboundEvent & { timestamp?: number },
  ctx: InboundContext,
  runner: (message: string, options?: RunnerOptions) => Promise<FastPathResult> = runModelFastPath,
): Promise<{ handled: boolean; reply?: { text: string } }> {
  if (!isOwnerFastPathEligible(event, ctx)) return { handled: false };
  const message = (event.bodyForAgent ?? event.content ?? "").trim();
  const graphSurface = surfaceFor(ctx);
  const reply = await dialogueTurn(runner, {
    surface: graphSurface === "whatsapp" ? "whatsapp" : "claw_live",
    graphSurface,
    conversationKey: conversationKey(event, ctx),
    eventRef: transportEventRef(ctx.runId, event.runId, event.idempotencyKey, event.id),
    text: message,
    caller: "owner",
    admittedAt: admittedAtMs(event.timestamp),
    policy: { modelAllowed: true },
    timeoutSeconds: 75,
  });
  if (!reply.handled) return { handled: false };
  return { handled: true, reply: { text: String(reply.text || "").trim() || "Claw n'a pas pu traiter la demande." } };
}
