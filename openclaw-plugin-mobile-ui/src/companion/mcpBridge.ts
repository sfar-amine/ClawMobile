import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { capabilityBridge, validateCapabilityDecision } from "./capabilityBridge";
import { runModelFastPath } from "../modelFastPath";
import * as modelFastPathHost from "../modelFastPath";
import { readMaintenanceGate } from "./maintenanceMarker";
import { PUBLIC_WEB_BUDGET_MS } from "./runWeb";

const MCP_MAINTENANCE_TEXT = "Samantha est en maintenance pour quelques minutes : la demande n'a pas été traitée et ne le sera pas plus tard. Renvoie-la après la maintenance.";
const MCP_MARKER_INVALID_TEXT = "Le verrou de maintenance de Samantha est illisible : par sécurité, aucune demande n'est exécutée.";
import { REMEMBER_KINDS, validateRemember } from "./memoryControl";
import {
  getRemoteBridgeRequest,
  hasContinuumTask,
  submitAuthenticatedMcpRequest,
  authenticatedMcpContextMetadata,
  mcpServiceScope,
} from "./remoteBridge";

const execFileAsync = promisify(execFile);
// External MCP keeps a read-only shadow profile and an owner profile that reuses canonical Claw authorization.
const SUPPORTED_PROFILES = new Set(["chat-owner-shadow", "chat-owner"]);
function accessMetadata(clientId:string,profile:string){
  return {client_id:clientId,profile:profile as "chat-owner"|"chat-owner-shadow",owner:profile === "chat-owner",read_only:profile !== "chat-owner"};
}
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,24}$/;
const ACTION_ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
const STEP_ID_RE = /^[A-Za-z0-9._-]{1,24}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ARTIFACT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const WORKSPACE = path.join(os.homedir(), ".openclaw", "workspace");
const UI_PLAYBOOKS = process.env.CLAW_UI_PLAYBOOKS_ROOT || path.join(WORKSPACE, "ui-playbooks");
const REQUEST_CONTEXT = path.join(
  UI_PLAYBOOKS,
  "tools",
  "request_context.py",
);
type McpRelayMessage = {
  requestId?: unknown;
  clientId?: unknown;
  profile?: unknown;
  tool?: unknown;
  arguments?: unknown;
};

function cleanObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeValue(value: any, depth = 0): any {
  if (depth > 20) return "[depth_limit]";
  if (Array.isArray(value)) return value.map((item) => safeValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(authorization|cookie|set-cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|credentials|private[_-]?key|stderr)$/i.test(key)) continue;
    out[key] = safeValue(item, depth + 1);
  }
  return out;
}

function projectReceipt(receipt: any) {
  const base = {
    request_id: receipt.requestId,
    task_id: receipt.taskId,
    step_id: receipt.stepId,
    retry_allowed: false,
  };
  if (receipt.state === "abandoned") {
    return {
      ...base,
      state: "abandoned",
      application: receipt.abandonment?.application || "effect_uncertain",
      mutation_risk: receipt.mutationRisk,
      error: "claw_execution_abandoned",
    };
  }
  if (receipt.state !== "completed") {
    return { ...base, state: receipt.state, error: receipt.error ? "claw_execution_failed" : undefined,
      ...(["mcp_read_protocol_required","mcp_read_deadline_exceeded","mcp_read_execution_failed"].includes(receipt.error)
        ? {reason:receipt.error} : {}) };
  }
  const value = receipt.result;
  if (receipt.method === "context_remember") {
    // Receipt only: the remembered text is never echoed back nor persisted in the receipt.
    return {
      ...base,
      state: value?.state === "recorded" ? "recorded" : value?.state === "refused" ? "refused" : "failed",
      event_id: value?.event_id,
      surface: value?.surface,
      kind: value?.kind,
      supersedes: value?.supersedes,
      reason: value?.reason,
    };
  }
  if (value?.artifact) {
    return { ...base, state: "result_available", artifact: safeValue(value.artifact), preview: String(value.preview || "").slice(0, 8000) };
  }
  if (receipt.method === "mcp_capability_execute_readonly" || receipt.method === "mcp_capability_execute_owner") {
    const execution = value?.execution || {};
    const domain = execution?.result;
    let state = "blocked";
    if (execution.state === "completed" || execution.state === "partial") state = domain?.ok === false || domain?.success === false || ["failed","insufficient_sources","cancelled"].includes(domain?.web?.outcome) ? "failed" : "completed";
    else if (execution.state === "failed") state = "failed";
    else if (execution.state === "running" || execution.state === "indeterminate") state = execution.state;
    else if (execution.state === "low_confidence" || domain?.state === "needs_counter" || domain?.state === "needs_clarification") state = "needs_clarification";
    return {
      ...base,
      state,
      capability: value?.capability,
      route: value?.selected?.route,
      reason: state === "blocked" ? (execution.reason || execution.state)
        : state === "failed" && value?.intentReadProtocol === "mcp-read.v1" ? readReason(execution.reason || domain?.reason) : undefined,
      result: safeValue(domain),
      question: domain?.question,
      choices: safeValue(domain?.choices),
      ...(value?.interpretationReceipt ? {interpretation_receipt:safeValue(value.interpretationReceipt)} : {}),
    };
  }
  return { ...base, state: "completed", result: safeValue(value) };
}

function requiredString(
  value: unknown,
  name: string,
  max: number,
  pattern?: RegExp,
) {
  const text = String(value || "").trim();
  if (!text || text.length > max || (pattern && !pattern.test(text))) {
    throw new Error(`invalid_${name}`);
  }
  return text;
}

function optionalString(
  value: unknown,
  name: string,
  max: number,
  pattern?: RegExp,
) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, name, max, pattern);
}

function actionTaskId(clientId: string, actionKey: string) {
  return `mcp:${clientId}:${actionKey}`;
}

function actionRequestId(clientId: string, actionKey: string, stepKey: string) {
  const value = `mcp-${clientId}-${actionKey}-${stepKey}`;
  if (!REQUEST_ID_RE.test(value)) throw new Error("invalid_action_identity");
  return value;
}

function bridgeParamsHash(method: string, params: Record<string, unknown>) {
  return crypto.createHash("sha256").update(JSON.stringify({ method, params })).digest("hex");
}

async function continuumIngress(args: string[]) {
  const env = { ...process.env } as Record<string, string>;
  env.PYTHONPATH = UI_PLAYBOOKS + (env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : "");
  const run: any = await execFileAsync("python3", ["-B", "-m", "skill_intelligence.continuum_ingress", ...args], {
    cwd: UI_PLAYBOOKS,
    timeout: 12_000,
    maxBuffer: 1024 * 1024,
    env,
  });
  const stdout = typeof run === "string" ? run : String(run?.stdout ?? "");
  return JSON.parse(stdout || "{}");
}

function withinWorkspace(filePath: string) {
  const resolved = path.resolve(filePath);
  return resolved === WORKSPACE || resolved.startsWith(WORKSPACE + path.sep);
}

function sanitizeRequestContext(raw: any) {
  const contracts = Array.isArray(raw?.contracts)
    ? raw.contracts.map((row: any) => {
        const { path: _path, ...rest } = row || {};
        return rest;
      })
    : [];
  const global = raw?.global && typeof raw.global === "object"
    ? (() => {
        const { path: _path, ...rest } = raw.global;
        return rest;
      })()
    : raw?.global;
  return { ...raw, contracts, global };
}

function contextSurface(clientId:string) {
  // Provenance from the admitted relay identity, never from tool arguments.
  if(/^codex(?:$|[._-])/i.test(clientId))return 'codex';
  if(/^claude(?:$|[._-])/i.test(clientId))return 'claude';
  if(/^(?:voice|bixby)(?:$|[._-])/i.test(clientId))return 'voice';
  if(/^(?:app|mobile)(?:$|[._-])/i.test(clientId))return 'app';
  return 'chat';
}

function contextScopes(value:unknown) {
  if(value===undefined||value===null||value==='')return [];
  const values=typeof value==='string'&&value.length<=512?value.split(','):Array.isArray(value)?value:null;
  if(!values||values.length>16)throw new Error('invalid_scopes');
  const scopes:string[]=[];
  for(const value of values){
    if(typeof value!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(value.trim()))throw new Error('invalid_scopes');
    if(!scopes.includes(value.trim()))scopes.push(value.trim());
  }
  // Membership is checked by the existing reader against its pinned manifest.
  return scopes;
}

async function contextBundle(args: Record<string, unknown>,clientId:string) {
  const query = requiredString(args.query, "query", 2000);
  const surface=contextSurface(clientId);
  // The authenticated client is an access principal, not a context consumer: two
  // independent conversations may use it. Only the caller's explicitly supplied
  // base describes what this consumer has received. Legacy callers reconstruct
  // conservatively instead of inheriting another conversation's server cursor.
  const argv = [REQUEST_CONTEXT, "--query", query, '--surface', surface];
  const scopes=contextScopes(args.scopes);
  if(scopes.length)argv.push('--scopes',scopes.join(','));

  const after = args.after_revision;
  if (after !== undefined && after !== null) {
    const revision = Number(after);
    if (!Number.isInteger(revision) || revision < 0) {
      throw new Error("invalid_after_revision");
    }
    argv.push("--after", String(revision));
  }

  const known = cleanObject(args.known_contracts);
  if (Object.keys(known).length) {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(known)) {
      const hash = String(value || "").trim();
      if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error("invalid_known_contract");
      normalized[key] = hash.toLowerCase();
    }
    argv.push("--known-contracts", JSON.stringify(normalized));
  }

  const baseline = cleanObject(args.global_baseline);
  if (Object.keys(baseline).length) {
    argv.push("--global-baseline", JSON.stringify(baseline));
  }
  if (args.uncertain === true) argv.push("--uncertain");

  const run: any = await execFileAsync("python3", argv, {
    cwd: path.dirname(REQUEST_CONTEXT),
    timeout: 12_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env },
  });
  const stdout = typeof run === "string" ? run : String(run?.stdout ?? "");
  const raw = JSON.parse(stdout || "{}");
  const required = new Set<string>(
    Array.isArray(raw?.readiness?.required_reads)
      ? raw.readiness.required_reads.map((item: unknown) => String(item))
      : [],
  );
  const reads: Array<{ key: string; sha256?: string; content: string }> = [];

  for (const row of Array.isArray(raw?.contracts) ? raw.contracts : []) {
    const key = String(row?.key || "");
    const filePath = String(row?.path || "");
    if (!required.has(key) || !filePath || !withinWorkspace(filePath)) continue;
    reads.push({
      key,
      sha256: row?.sha256 ? String(row.sha256) : undefined,
      content: fs.readFileSync(filePath, "utf8"),
    });
  }

  if (raw?.global?.read_required === true) {
    const filePath = String(raw?.global?.path || "");
    if (!filePath || !withinWorkspace(filePath)) throw new Error("invalid_global_context_path");
    if (!reads.some((row) => row.key === "context/HYBRID_CONTEXT.md")) {
      reads.push({
        key: "context/HYBRID_CONTEXT.md",
        sha256: raw?.global?.sha256 ? String(raw.global.sha256) : undefined,
        content: fs.readFileSync(filePath, "utf8"),
      });
    }
  }

  if(raw?.foundation?.read_required===true){
    const content=JSON.stringify(raw.foundation);
    reads.push({key:'context/FOUNDATION',sha256:crypto.createHash('sha256').update(content).digest('hex'),content});
    const {content:_content,skills:_skills,sources:_sources,instruction:_instruction,...metadata}=raw.foundation;
    raw.foundation=metadata;
  }
  // Building a response does not attest its delivery or the client's integration.
  // A lost response is replayable from the same explicit base; no new cursor
  // store, thread identifier, or acknowledgement endpoint is needed.
  raw.cursor_advanced=false;
  if(raw.cursor&&typeof raw.cursor==='object')raw.cursor.advanced=false;
  raw.context_consumption={state:'not_attested',basis:'caller_supplied_state',implicit_client_cursor:false};
  return {
    state: "context",
    bundle: sanitizeRequestContext(raw),
    required_reads: reads,
    attestation: reads.length
      ? "Read and integrate every required_reads item before reusing its hash/baseline."
      : "No additional contract read is required for this delta.",
  };
}

// Versioned opt-in transport, not a second interpreter, dialogue owner or authorization API.
const MCP_INPUT_PROTOCOL = "mcp-input.v1";
const CLIENT_REF_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const CLIENT_CONTEXT_FIELDS = ["schema_version", "original_message", "conversation_ref", "local_revision", "relevant_turns",
  "entity_references", "active_goal_ref", "pending_question_ref", "confirmation_ref", "user_reply_ref", "completeness", "missing"];

function clientObject(value:unknown, keys:string[]) {
  if(!value || typeof value!=="object" || Array.isArray(value) ||
     Object.keys(value).length!==keys.length || Object.keys(value).some(key=>!keys.includes(key))) {
    throw new Error("invalid_client_context");
  }
  return value as Record<string,any>;
}
function clientText(value:unknown,max:number,ref=false) {
  if(typeof value!=="string" || !value.length || value.length>max || (ref&&!CLIENT_REF_RE.test(value))) {
    throw new Error("invalid_client_context");
  }
}
function clientRef(value:unknown) { if(value!==null)clientText(value,128,true); }

/** All fields are external claims. Never upgrade a hash, client reference or narrative into server authority. */
export function validateMcpClientContext(request:unknown,value:unknown) {
  clientText(request,12000);
  const context=clientObject(value,CLIENT_CONTEXT_FIELDS);
  if(context.schema_version!==MCP_INPUT_PROTOCOL)throw new Error("invalid_client_context_version");
  const message=clientObject(context.original_message,["text","ref"]);
  clientText(message.text,12000);clientRef(message.ref);
  if(message.text!==request)throw new Error("original_message_mismatch");
  clientText(context.conversation_ref,128,true);
  if(context.local_revision!==null && !(typeof context.local_revision==='string'&&context.local_revision.length>0&&context.local_revision.length<=128) &&
     !(Number.isSafeInteger(context.local_revision)&&context.local_revision>=0))throw new Error("invalid_client_context");
  if(!Array.isArray(context.relevant_turns)||context.relevant_turns.length>8)throw new Error("invalid_client_context");
  for(const item of context.relevant_turns){
    const turn=clientObject(item,["ref","role","text"]);clientRef(turn.ref);clientText(turn.text,2000);
    if(!["user","assistant"].includes(turn.role))throw new Error("invalid_client_context");
  }
  if(!Array.isArray(context.entity_references)||context.entity_references.length>16)throw new Error("invalid_client_context");
  for(const item of context.entity_references){
    const reference=clientObject(item,["mention","turn_ref","server_ref"]);clientText(reference.mention,256);clientRef(reference.turn_ref);
    if(reference.server_ref!==null){
      const server=clientObject(reference.server_ref,["kind","request_id"]);
      if(server.kind!=="remote_bridge_receipt")throw new Error("invalid_client_context");
      clientText(server.request_id,128,true);
    }
  }
  for(const key of ["active_goal_ref","pending_question_ref","confirmation_ref","user_reply_ref"])clientRef(context[key]);
  if(!["complete","partial","unknown"].includes(context.completeness)||!Array.isArray(context.missing)||context.missing.length>16)throw new Error("invalid_client_context");
  for(const item of context.missing)clientText(item,128);
  const encoded=JSON.stringify({request,client_context:context});
  if(Buffer.byteLength(encoded,"utf8")>32768)throw new Error("client_context_too_large");
  // Copy data across the boundary; no caller objects or accessors survive it.
  return JSON.parse(encoded).client_context as Record<string,any>;
}

function mcpInputFailure(reason:string,outcome="TECHNICAL_FAILURE") {
  return {state:"failed",outcome,reason,retry_allowed:false,input_protocol:MCP_INPUT_PROTOCOL};
}

function stableMcpInput(value:any):any {
  if(Array.isArray(value))return value.map(stableMcpInput);
  if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableMcpInput(value[key])]));
  return value;
}
function readReason(value:unknown) {
  return typeof value==="string"&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value)?value:"interpretation_read_failed";
}
async function executeMigratedMcpRead(requestId:string,clientId:string,profile:string,args:Record<string,unknown>,context:Record<string,any>,actionKey:string,stepKey:string,admission?:object) {
  const input={request:args.request,client_context:context,service_scope:mcpServiceScope(args.service_scope)!};
  const inputDigest=crypto.createHash("sha256").update(JSON.stringify(stableMcpInput(input))).digest("hex");
  const receipt=await submitAuthenticatedMcpRequest({
    requestId,taskId:actionTaskId(clientId,actionKey),stepId:stepKey,sessionId:`external_mcp:${clientId}`,
    _claw_access:accessMetadata(clientId,profile),method:"mcp_capability_execute_readonly",
    params:{intentInputProtocol:MCP_INPUT_PROTOCOL,inputDigest},
  },undefined,async bounds=>{
    const remaining=Math.floor(bounds.deadlineEpochMs-Date.now());
    if(remaining<1)throw new Error("mcp_read_deadline_exceeded");
    const out:any=await runModelFastPath(args.request as string,{
      surface:"mcp",caller:profile==="chat-owner"?"owner":"other",originId:requestId,
      requestId,runId:requestId,sessionId:`external_mcp:${clientId}`,timeoutSeconds:15,
      remainingBudgetMs:remaining,deadlineEpochMs:bounds.deadlineEpochMs,
      intentContext:input,intentReadOnly:true,intentContextAdmission:admission,
      dialogue:{mode:"preview",event:{conversationKey:`external_mcp:${clientId}:${context.conversation_ref}`,eventRef:requestId}},
    } as any);
    if(out?.intentInputProtocol!==MCP_INPUT_PROTOCOL || out?.intentReadProtocol!=="mcp-read.v1")throw new Error("mcp_read_protocol_required");
    const completed=out.status==="hit"&&["completed","partial"].includes(out.execution_state);
    const clarification=out.status==="clarification" && typeof out.clarification?.question==="string";
    const execution={state:completed?out.execution_state:clarification?"low_confidence":["running","indeterminate"].includes(out.execution_state)?out.execution_state:"failed",
      reason:completed?undefined:readReason(out.reason),
      result:completed?safeValue(out.result):clarification?{state:"needs_clarification",question:out.clarification.question,choices:safeValue(out.clarification.choices)}:{ok:false,state:"failed",reason:readReason(out.reason)}};
    // The host already projects this metadata; copy only its receipt fields,
    // never a generated output, full resolution, prompt or transcript.
    const receiptKeys=["schema_version","adapter_version","prompt_version","request_id","turn_id","generation_id",
      "conversation_ref","conversation_revision","context_digest","catalogue_digest","prompt_digest","status","model","actual_model","usage","inference_mode"];
    const interpretationReceipt=out.interpretationReceipt&&typeof out.interpretationReceipt==="object"
      ? Object.fromEntries(receiptKeys.filter(key=>out.interpretationReceipt[key]!==undefined).map(key=>[key,safeValue(out.interpretationReceipt[key])])):undefined;
    // C9 v2 adds only bounded source metadata, never source bodies or host authority.
    const shared=out.interpretationReceipt?.shared_source_refs;
    const sharedDigest=out.interpretationReceipt?.shared_context_digest;
    if(interpretationReceipt && Array.isArray(shared) && shared.length<=64 &&
       ((shared.length===0 && sharedDigest===null) || (shared.length>0 && typeof sharedDigest==="string" && /^sha256:[0-9a-f]{64}$/.test(sharedDigest))) &&
       shared.every(row=>row&&typeof row.ref==="string"&&row.ref.length>0&&row.ref.length<=200&&
         typeof row.sha256==="string"&&/^sha256:[0-9a-f]{64}$/.test(row.sha256)&&
         (row.revision===null||(Number.isSafeInteger(row.revision)&&row.revision>=0))&&
         Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=96000)) {
      interpretationReceipt.shared_context_digest=sharedDigest;
      interpretationReceipt.shared_source_refs=shared.map(({ref,sha256,revision,bytes})=>({ref,sha256,revision,bytes}));
    }
    return {intentReadProtocol:"mcp-read.v1",execution,interpretationReceipt,capability:typeof out.capability==="string"?out.capability:undefined,
      selected:{route:typeof out.route==="string"?out.route:undefined}};
  });
  return projectReceipt(receipt);
}

async function migratedMcpInput(requestId:string,clientId:string,profile:string,args:Record<string,unknown>,execute:boolean,admission?:object) {
  if(args.decision!==undefined||args.target_hint!==undefined)return mcpInputFailure("client_semantic_authority_not_admitted");
  const service=mcpServiceScope(args.service_scope);
  if(!service)return mcpInputFailure("MCP_INTERPRETATION_SERVICE_REQUIRED");
  const host=authenticatedMcpContextMetadata(admission);
  if(!host?.service_scope || host.client_id!==clientId || host.request_id!==requestId || profile!=="chat-owner")
    return mcpInputFailure("MCP_INTERPRETATION_SERVICE_UNVERIFIED");
  let context:Record<string,any>;
  try {context=validateMcpClientContext(args.request,args.client_context);}
  catch(error:any){return mcpInputFailure(error?.message||"invalid_client_context");}
  if(execute){
    const actionKey=requiredString(args.action_key,"action_key",40,ACTION_ID_RE);
    const stepKey=optionalString(args.step_key,"step_key",24,STEP_ID_RE)||"execute";
    if(requestId!==actionRequestId(clientId,actionKey,stepKey))throw new Error("action_request_id_mismatch");
    // A settled/uncertain receipt is not a new interpretation. Delegate all hash,
    // access and step checks to the same owner even if the model port is down.
    if(getRemoteBridgeRequest(requestId))return executeMigratedMcpRead(requestId,clientId,profile,args,context,actionKey,stepKey,admission);
  }
  // Never let a new envelope fall through to a runner/helper that ignores it.
  if(process.env.SAMANTHA_INTENT_INTERPRETER!=="1" ||
     (modelFastPathHost as any).INTENT_INPUT_PROTOCOL!==MCP_INPUT_PROTOCOL) {
    return mcpInputFailure("INTERPRETATION_HOST_UNAVAILABLE");
  }
  const lock=readMaintenanceGate(clientId);
  if(lock.state==="closed")return {state:"refused",outcome:"MAINTENANCE",reason:lock.reason,retry_allowed:false};
  // A receipt identifier is not an entity resolver or a confirmation attestation.
  // Its admission must come from the existing receipt/entity owner, not JSON or a checksum.
  if(context.entity_references.some((ref:any)=>ref.server_ref!==null)) {
    return mcpInputFailure("server_reference_admission_unavailable","CLIENT_CONTEXT_INCOMPLETE");
  }
  if(execute){
    const actionKey=requiredString(args.action_key,"action_key",40,ACTION_ID_RE);
    const stepKey=optionalString(args.step_key,"step_key",24,STEP_ID_RE)||"execute";
    if(requestId!==actionRequestId(clientId,actionKey,stepKey))throw new Error("action_request_id_mismatch");
    if((modelFastPathHost as any).INTENT_READ_PROTOCOL!=="mcp-read.v1") {
      return {...mcpInputFailure("INTERPRETATION_OWNER_RECEIPT_REQUIRED"),request_id:requestId,task_id:actionTaskId(clientId,actionKey)};
    }
    return executeMigratedMcpRead(requestId,clientId,profile,args,context,actionKey,stepKey,admission);
  }
  const conversationKey=`external_mcp:${clientId}:${context.conversation_ref}`;
  try {
    const out:any=await runModelFastPath(args.request as string,{
      surface:"mcp",caller:profile==="chat-owner"?"owner":"other",originId:requestId,
      requestId,sessionId:`external_mcp:${clientId}`,timeoutSeconds:15,checkOnly:true,
      intentContext:{request:args.request,client_context:context,service_scope:service},intentContextAdmission:admission,
      dialogue:{mode:"preview",event:{conversationKey,eventRef:requestId}},
    } as any);
    if(out?.intentInputProtocol!==MCP_INPUT_PROTOCOL)return mcpInputFailure("INTERPRETATION_HOST_UNAVAILABLE");
    // Return the native preview/diagnostic. Nothing here produces a business success
    // or copies client transcripts into durable Bridge params or receipts.
    return {state:"resolved",input_protocol:MCP_INPUT_PROTOCOL,input_provenance:"client_reported",
      context_consumption:"not_attested",result:safeValue(out)};
  } catch {return mcpInputFailure("interpretation_transport_error");}
}

/** SAM-MIG V2.2 §5.5: MCP keeps no server-side dialogue state. `claw_resolve` is the coordinator's
 * preview_resolution (no dialogue state read or written, no effect); its normalized outcome comes from the single
 * status table, alongside the unchanged resolution. The client answers a question with a completed request and a
 * new action_key. */
export async function dialoguePreview(request: string, clientId?: string, runner = runModelFastPath) {
  try {
    const out: any = await runner(request, { surface: "external_mcp", caller: "owner", originId: "mcp-preview",
      timeoutSeconds: 15, checkOnly: true,
      dialogue: { mode: "preview", ...(clientId ? { event: { conversationKey: clientId } } : {}) } });
    if (out && typeof out.outcome === "string") {
      return { outcome: out.outcome, reasonCode: out.reasonCode, statusTable: out.statusTable, ...(out.text ? { text: out.text } : {}),
        ...(out.question ? { question: out.question } : {}), ...(out.klass ? { klass: out.klass } : {}) };
    }
  } catch {}
  return { outcome: "TECHNICAL_FAILURE", reasonCode: "coordinator_unavailable" };
}

export function typedMcpSelection(args: Record<string, unknown>): Record<string, unknown> | undefined {
  // The already published connector exposes decision:{} but may cache an older tools/list without typed.
  // This closed envelope transports selection only: it never grants authority or user confirmation.
  const envelope = args.decision && typeof args.decision === "object" && !Array.isArray(args.decision) &&
    (args.decision as any).kind === "samantha.typed-selection.v1" ? args.decision as Record<string, unknown> : undefined;
  if (args.typed === undefined && !envelope) return undefined;
  if (process.env.SAMANTHA_BRAIN_ONLY !== "1") throw new Error("typed_path_not_active");
  if ((envelope && (Object.keys(envelope).length !== 2 || !Object.prototype.hasOwnProperty.call(envelope, "selection") || args.typed !== undefined)) ||
      ["client_context", "service_scope", "target_hint"].some(key => args[key] !== undefined) ||
      (!envelope && args.decision !== undefined)) throw new Error("typed_input_conflict");
  const value = (envelope ? envelope.selection : args.typed) as any;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3 ||
      Object.keys(value).some(k => !["domain", "action", "params"].includes(k)) ||
      !/^[a-z][a-z0-9_.-]{0,127}$/.test(value.domain) || !/^[a-z][a-z0-9_.-]{0,127}$/.test(value.action) ||
      !value.params || typeof value.params !== "object" || Array.isArray(value.params) || Buffer.byteLength(JSON.stringify(value)) > 32768)
    throw new Error("typed_input_invalid");
  return JSON.parse(JSON.stringify(value));
}

async function resolveCapability(args: Record<string, unknown>, clientId?: string, requestId?: string) {
  const request = requiredString(args.request, "request", 12000);
  const typedSelection = typedMcpSelection(args);
  if (typedSelection) return capabilityBridge(request, {execute: false, surface: "external_mcp", caller: "owner",
    timeoutSeconds: 20, typedSelection, requestId: requestId || "typed-preview"});
  const targetHint = optionalString(args.target_hint, "target_hint", 128, /^[A-Za-z0-9._-]+$/);
  const [resolved, dialogue] = await Promise.all([capabilityBridge(request, {
    execute: false,
    surface: "external_mcp",
    caller: "owner",
    timeoutSeconds: 20,
    targetHint,
  }), dialoguePreview(request, clientId)]);
  return { ...resolved, dialogue };
}

async function executeCapability(
  requestId: string,
  clientId: string,
  profile: string,
  args: Record<string, unknown>,
) {
  const webBounds={startedMonotonic:performance.now(),deadlineEpochMs:Date.now()+PUBLIC_WEB_BUDGET_MS};
  const request = requiredString(args.request, "request", 12000);
  const typedSelection = typedMcpSelection(args);
  const actionKey = requiredString(args.action_key, "action_key", 40, ACTION_ID_RE);
  const stepKey = optionalString(args.step_key, "step_key", 24, STEP_ID_RE) || "execute";
  const targetHint = optionalString(args.target_hint, "target_hint", 128, /^[A-Za-z0-9._-]+$/);
  const expectedRequestId = actionRequestId(clientId, actionKey, stepKey);
  if (requestId !== expectedRequestId) throw new Error("action_request_id_mismatch");

  const taskId = actionTaskId(clientId, actionKey);
  // SAM-MIG V2.2 §12.1, fail-closed: the durable marker is read directly (no coordinator in the path), so a broken
  // or unreachable coordinator never opens the lock. Nothing is kept to resume; the action_key stays the owner's
  // replay protection (T-M01, T-X05).
  const lock = readMaintenanceGate(clientId);
  if (lock.state === "closed") {
    return { state: "refused", request_id: requestId, task_id: taskId, retry_allowed: false, reason: lock.reason,
      outcome: "MAINTENANCE", text: lock.reason === "maintenance" ? MCP_MAINTENANCE_TEXT : MCP_MARKER_INVALID_TEXT };
  }
  const gate = typedSelection ? {outcome: "UNRESOLVED", reasonCode: undefined} : await dialoguePreview(request, clientId);
  if (gate.outcome === "MAINTENANCE") {
    return { state: "refused", request_id: requestId, task_id: taskId, retry_allowed: false, reason: "maintenance",
      text: (gate as any).text || MCP_MAINTENANCE_TEXT, outcome: "MAINTENANCE" };
  }
  if (gate.outcome === "TECHNICAL_FAILURE" && gate.reasonCode === "coordinator_unavailable") {
    // Bounded error for an execution (missions and effects); claw_resolve keeps its stateless preview.
    return { state: "failed", request_id: requestId, task_id: taskId, retry_allowed: false,
      reason: "coordinator_unavailable", outcome: "TECHNICAL_FAILURE" };
  }
  const method = profile === "chat-owner" ? "mcp_capability_execute_owner" : "mcp_capability_execute_readonly";
  const suppliedDecision = !typedSelection && args.decision && typeof args.decision === "object" && !Array.isArray(args.decision)
    ? args.decision as Record<string, unknown>
    : undefined;
  let resolved: any = undefined;
  let preparedDecision: any = suppliedDecision;
  if (preparedDecision) {
    const validation: any = await validateCapabilityDecision(request, preparedDecision, { timeoutSeconds: 20,checkBudgetMs:Math.max(1,Math.min(10000,webBounds.deadlineEpochMs-Date.now())) });
    if (validation?.state !== "valid" || !validation?.decision) {
      return {
        state: "revalidation_required", request_id: requestId, task_id: taskId, retry_allowed: false,
        reason: validation?.reason || validation?.state || validation?.error || "decision_validation_failed",
      };
    }
    preparedDecision = validation.decision;
    resolved = validation.resolution || {};
  } else {
    resolved = await capabilityBridge(request, {
      execute: false, surface: "external_mcp", caller: "owner", timeoutSeconds: 20, targetHint,requestId,checkBudgetMs:Math.max(1,Math.min(10000,webBounds.deadlineEpochMs-Date.now())),
      ...(typedSelection ? {typedSelection} : {}),
    });
    preparedDecision = resolved?.decision && typeof resolved.decision === "object" ? resolved.decision : undefined;
    if(resolved?.success===false){
      return {state:"failed",request_id:requestId,task_id:taskId,retry_allowed:false,
        reason:"capability_resolution_unavailable"};
    }
  }
  const selected = resolved?.selected || {};
  const selectedRisk = String(preparedDecision?.risk || selected?.risk || "read");
  const continuumDecision = preparedDecision?.continuum || resolved?.continuum || resolved?.harness?.continuum || {};
  const durable = continuumDecision?.mode === "durable";
  const params = {
    request, targetHint: targetHint || "",
    ...(typedSelection ? {typedSelection} : {}),
    ...(preparedDecision ? { decision: preparedDecision } : {}),
  };

  // Shadow writes keep the existing read-only denial and never create a durable write mission.
  if (profile === "chat-owner-shadow" && selectedRisk !== "read") {
    const receipt = await submitAuthenticatedMcpRequest({
      requestId, taskId, stepId: stepKey, sessionId: `external_mcp:${clientId}`,
      _claw_access: accessMetadata(clientId,profile),
      method, params,
    });
    return projectReceipt(receipt);
  }

  let wireStepId = stepKey;
  let continuumFence: any = undefined;
  let continuumState: any = undefined;
  if (durable) {
    const capability = requiredString(preparedDecision?.capability || selected?.capability || resolved?.capability, "capability", 128, /^[A-Za-z0-9._-]+$/);
    const prepared = await continuumIngress([
      "prepare",
      "--task-id", taskId,
      "--step-id", stepKey,
      "--request-id", requestId,
      "--method", method,
      "--params-hash", bridgeParamsHash(method, params),
      "--capability", capability,
      // The Bridge fences every owner execution whose decision is not `read`: arm the fence on the same rule.
      "--risk", String(preparedDecision?.risk || "").trim() === "read" ? "read" : "write",
      "--owner-id", `mcp-${clientId}`,
    ]);
    continuumState = prepared;
    if (prepared.state === "observe_existing" || prepared.state === "step_settled") {
      const existing = getRemoteBridgeRequest(requestId);
      if (existing) {
        const status = await continuumIngress(["status", "--task-id", taskId]);
        return { ...projectReceipt(existing), continuum: status };
      }
      return {
        state: prepared.mission_state || "running",
        request_id: requestId,
        task_id: taskId,
        retry_allowed: false,
        continuum: prepared,
      };
    }
    if (prepared.state !== "ready" || prepared.dispatch_allowed !== true) {
      return {
        state: prepared.state || "blocked",
        request_id: requestId,
        task_id: taskId,
        retry_allowed: false,
        continuum: prepared,
      };
    }
    wireStepId = requiredString(prepared.wire_step_id, "wire_step_id", 128, REQUEST_ID_RE);
    continuumFence = prepared.continuum_fence || undefined;
  }

  const receipt = await submitAuthenticatedMcpRequest({
    requestId,
    taskId,
    stepId: wireStepId,
    sessionId: `external_mcp:${clientId}`,
      _claw_access: accessMetadata(clientId,profile),
    method,
    params,
    ...(continuumFence ? { continuumFence } : {}),
  },webBounds);

  const projected: any = projectReceipt(receipt);
  if (!durable) return projected;
  try {
    await continuumIngress(["settle", "--task-id", taskId, "--request-id", requestId]);
    continuumState = await continuumIngress(["status", "--task-id", taskId]);
  } catch {
    continuumState = { state: "verification_required", retry_allowed: false };
  }
  return { ...projected, continuum: continuumState };
}

export async function executeRawCommand(
  requestId: string,
  clientId: string,
  profile: string,
  args: Record<string, unknown>,
  dependencies: {hasTask?:typeof hasContinuumTask;ingress?:typeof continuumIngress;submit?:typeof submitAuthenticatedMcpRequest;getRequest?:typeof getRemoteBridgeRequest} = {},
) {
  const hasTask=dependencies.hasTask || hasContinuumTask;
  const ingress=dependencies.ingress || continuumIngress;
  const submit=dependencies.submit || submitAuthenticatedMcpRequest;
  const getRequest=dependencies.getRequest || getRemoteBridgeRequest;
  if (profile !== "chat-owner") throw new Error("owner_profile_required");
  const command = requiredString(args.command, "command", 32768);
  const actionKey = requiredString(args.action_key, "action_key", 40, ACTION_ID_RE);
  const stepKey = optionalString(args.step_key, "step_key", 24, STEP_ID_RE) || "execute";
  const expectedRequestId = actionRequestId(clientId, actionKey, stepKey);
  if (requestId !== expectedRequestId) throw new Error("action_request_id_mismatch");

  const cwd = optionalString(args.cwd, "cwd", 4096);
  const timeoutMs = args.timeout_ms === undefined ? 30_000 : Number(args.timeout_ms);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new Error("invalid_timeout_ms");
  }

  const taskId = actionTaskId(clientId, actionKey);
  const method = "exec_wait";
  const params = { command, ...(cwd ? { cwd } : {}), timeoutMs };
  const paramsHash = bridgeParamsHash(method, params);
  const observed = hasTask(taskId) ? await ingress(["status", "--task-id", taskId]) : {state:"not_found"};
  if (!observed || typeof observed.state !== "string" || !observed.state) throw new Error("continuum_status_invalid");
  let wireStepId = stepKey;
  let continuumFence: any;
  const durable = observed?.state && observed.state !== "not_found";
  if (durable) {
    // Metadata comes only from the canonical task projection, never tool arguments.
    const capability = String(observed.capability || "");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(capability)) {
      return {state:"blocked",error:"continuum_capability_unavailable",request_id:requestId,task_id:taskId,
        retry_allowed:false,continuum:observed};
    }
    const existing = getRequest(requestId);
    if (existing && (existing.requestId !== requestId || existing.taskId !== taskId || existing.method !== method || existing.paramsHash !== paramsHash)) {
      throw new Error("request_id_conflict");
    }
    if (existing) return {...projectReceipt(existing),continuum:observed};
    const prepared = await ingress([
      "prepare", "--task-id", taskId, "--step-id", stepKey, "--request-id", requestId,
      "--method", method, "--params-hash", paramsHash, "--capability", capability,
      "--risk", "write", "--owner-id", `mcp-${clientId}`,
    ]);
    if (prepared.state !== "ready" || prepared.dispatch_allowed !== true) {
      return {state:prepared.mission_state || prepared.state || "blocked",request_id:requestId,task_id:taskId,
        retry_allowed:false,continuum:prepared};
    }
    wireStepId = requiredString(prepared.wire_step_id, "wire_step_id", 128, REQUEST_ID_RE);
    continuumFence = prepared.continuum_fence;
    // No fabricated fence or read classification: the Bridge validates the canonical armed effect.
    if (!continuumFence) throw new Error("continuum_fence_required");
  }
  const receipt = await submit({
    requestId, taskId, stepId:wireStepId, sessionId:`external_mcp:${clientId}`,
    _claw_access:accessMetadata(clientId,profile), method, params,
    ...(continuumFence ? {continuumFence} : {}),
  });
  const projected = projectReceipt(receipt);
  if (!durable) return projected;
  let continuum: any;
  try {
    await ingress(["settle", "--task-id", taskId, "--request-id", requestId]);
    continuum = await ingress(["status", "--task-id", taskId]);
  } catch { continuum = {state:"verification_required",retry_allowed:false}; }
  return {...projected,continuum};
}

async function rememberFact(
  requestId: string,
  clientId: string,
  profile: string,
  args: Record<string, unknown>,
) {
  if (profile !== "chat-owner") throw new Error("owner_profile_required");
  const actionKey = requiredString(args.action_key, "action_key", 40, ACTION_ID_RE);
  const stepKey = "execute";
  const expectedRequestId = actionRequestId(clientId, actionKey, stepKey);
  if (requestId !== expectedRequestId) throw new Error("action_request_id_mismatch");
  const kind = String(args.kind || "");
  if (!(REMEMBER_KINDS as readonly string[]).includes(kind)) throw new Error("invalid_kind");
  // Surface comes from the admitted relay identity, never from tool arguments.
  const params = validateRemember({
    surface: contextSurface(clientId),
    kind,
    text: args.text,
    supersedes: args.supersedes,
  });
  const receipt = await submitAuthenticatedMcpRequest({
    requestId,
    taskId: actionTaskId(clientId, actionKey),
    stepId: stepKey,
    sessionId: `external_mcp:${clientId}`,
    _claw_access: accessMetadata(clientId, profile),
    method: "context_remember",
    params: { surface: params.surface, kind: params.kind, text: params.text, ...(params.supersedes ? { supersedes: params.supersedes } : {}) },
  });
  return projectReceipt(receipt);
}

async function statusFor(
  clientId: string,
  args: Record<string, unknown>,
) {
  const actionKey = requiredString(args.action_key, "action_key", 40, ACTION_ID_RE);
  const stepKey = optionalString(args.step_key, "step_key", 24, STEP_ID_RE) || "execute";
  const requestId = actionRequestId(clientId, actionKey, stepKey);
  const taskId = actionTaskId(clientId, actionKey);
  const receipt = getRemoteBridgeRequest(requestId);
  let continuum: any = undefined;
  try {
    const status = await continuumIngress(["status", "--task-id", taskId]);
    if (status?.state && status.state !== "not_found") continuum = status;
  } catch {}
  if (!receipt) {
    if (continuum) return { ...continuum, request_id: requestId, task_id: taskId, retry_allowed: false, continuum };
    return {
      state: "not_found",
      request_id: requestId,
      retry_allowed: false,
    };
  }
  const projected: any = projectReceipt(receipt);
  return continuum ? { ...projected, continuum } : projected;
}

async function readArtifact(
  requestId: string,
  clientId: string,
  profile: string,
  args: Record<string, unknown>,
) {
  const artifactId = requiredString(args.artifact_id, "artifact_id", 128, ARTIFACT_ID_RE);
  const sourceRequestId = requiredString(args.source_request_id, "source_request_id", 128, REQUEST_ID_RE);
  const source = getRemoteBridgeRequest(sourceRequestId);
  if (!source || source.sessionId !== `external_mcp:${clientId}`) throw new Error("artifact_source_not_allowed");
  if ((source.result as any)?.artifact?.artifactId !== artifactId) throw new Error("artifact_not_allowed");
  const offset = args.offset === undefined ? 0 : Number(args.offset);
  const maxBytes = args.max_bytes === undefined ? 48 * 1024 : Number(args.max_bytes);
  if (!Number.isInteger(offset) || offset < 0) throw new Error("invalid_offset");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 48 * 1024) {
    throw new Error("invalid_max_bytes");
  }
  const stableId = `mcp-artifact:${crypto
    .createHash("sha256")
    .update(JSON.stringify([clientId, sourceRequestId, artifactId, offset, maxBytes]))
    .digest("hex")
    .slice(0, 32)}`;

  const receipt = await submitAuthenticatedMcpRequest({
    requestId: stableId,
    sessionId: `external_mcp:${clientId}`,
      _claw_access: accessMetadata(clientId,profile),
    method: "artifact_read",
    params: { artifactId, offset, maxBytes },
  });
  if (receipt.state !== "completed") {
    return { state: receipt.state, error: receipt.error ? "artifact_read_failed" : undefined, request_id: receipt.requestId };
  }
  return { state: "completed", request_id: receipt.requestId, result: safeValue(receipt.result) };
}

export async function handleMcpRelayRequest(message: McpRelayMessage) {
  const requestId = requiredString(message.requestId, "request_id", 128, REQUEST_ID_RE);
  const clientId = requiredString(message.clientId, "client_id", 24, CLIENT_ID_RE);
  const profile = requiredString(message.profile, "profile", 64);
  const tool = requiredString(message.tool, "tool", 64, /^[a-z][a-z0-9_]{1,63}$/);
  const args = cleanObject(message.arguments);

  if (!SUPPORTED_PROFILES.has(profile)) {
    return { state: "failed", error: "unsupported_profile" };
  }

  switch (tool) {
    case "claw_context":
      return contextBundle(args,clientId);
    case "claw_resolve":
      typedMcpSelection(args);
      if(args.service_scope!==undefined&&!Object.prototype.hasOwnProperty.call(args,"client_context"))return mcpInputFailure("client_context_required_for_service_scope");
      if(Object.prototype.hasOwnProperty.call(args,"client_context"))return migratedMcpInput(requestId,clientId,profile,args,false,message);
      return { state: "resolved", result: await resolveCapability(args, clientId, requestId) };
    case "claw_execute":
      typedMcpSelection(args);
      if(args.service_scope!==undefined&&!Object.prototype.hasOwnProperty.call(args,"client_context"))return mcpInputFailure("client_context_required_for_service_scope");
      if(Object.prototype.hasOwnProperty.call(args,"client_context"))return migratedMcpInput(requestId,clientId,profile,args,true,message);
      return executeCapability(requestId, clientId, profile, args);
    case "claw_exec":
      return executeRawCommand(requestId, clientId, profile, args);
    case "claw_remember":
      return rememberFact(requestId, clientId, profile, args);
    case "claw_status":
      return statusFor(clientId, args);
    case "claw_artifact_read":
      return readArtifact(requestId, clientId, profile, args);
    default:
      return { state: "failed", error: "unsupported_mcp_tool" };
  }
}
