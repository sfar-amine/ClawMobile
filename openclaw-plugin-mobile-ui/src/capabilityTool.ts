import {runtimeFile} from "./runtimeRoot";
import {createHash} from "node:crypto";
import {runCapabilityHelperProcess} from "./companion/capabilityBridge";
import {PUBLIC_WEB_BUDGET_MS, readRunWebResult} from "./companion/runWeb";
import os from "node:os";
import path from "node:path";

import { AGENT_CAPABILITY_REFUSAL } from "./capabilityAgentGuard";


export type CapabilityArgs = {
  request?: string;
  execute?: boolean;
  surface?: "chatgpt" | "gemini_claw" | "gemini_live" | "bixby" | "whatsapp";
  caller?: "owner" | "trusted" | "other";
  timeoutSeconds?: number;
};

/** OpenClaw 2026.9.6 plugin factory context; never supplied in model arguments. */
export type CapabilityTurnContext = {
  senderIsOwner?: boolean;
  nativeChannelId?: string;
  /** Set only by the SDK callback; never read from model arguments. */
  invocationId?: string;
  assertInvocationCurrent?: () => void;
};

type CapabilityOptions = { helperPath?: string; home?: string; turnContext?: CapabilityTurnContext };

export function createCapabilityTool(context: CapabilityTurnContext, options: Omit<CapabilityOptions, "turnContext"> = {}) {
  // Snapshot the host bit for this factory invocation, not a session-wide identity.
  const turnContext = {
    senderIsOwner: context?.senderIsOwner,
    nativeChannelId:typeof context?.nativeChannelId === "string" ? context.nativeChannelId : undefined,
    assertInvocationCurrent: typeof context?.assertInvocationCurrent === "function"
      ? context.assertInvocationCurrent.bind(context) : undefined,
  };
  const schema = {
    type: "object",
    properties: {
      request: { type: "string", minLength: 1, maxLength: 12000 },
      execute: { type: "boolean" },
      surface: { type: "string", enum: ["chatgpt", "gemini_claw", "gemini_live", "bixby", "whatsapp"] },
      // Compatibility only. This field can never grant authority.
      caller: { type: "string", enum: ["owner", "trusted", "other"] },
      timeoutSeconds: { type: "integer", minimum: 2, maximum: 120 },
    },
    required: ["request"], additionalProperties: false,
  };
  return {
    name: "clawmobile_capability",
    description: "Resolve the canonical Claw capability graph using host-admitted turn authority, optionally executing its validated route.",
    schema, inputSchema: schema, parameters: schema,
    async execute(_toolCallId: unknown, args: CapabilityArgs) {
      const result = await clawmobile_capability(args ?? {}, { ...options, turnContext:{...turnContext,invocationId:typeof _toolCallId === "string"?_toolCallId:undefined} });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  };
}

function helperCandidates(home = os.homedir()): string[] {
  return [
    runtimeFile("claw-capability.py", home),
  ];
}

export async function clawmobile_capability(
  args: CapabilityArgs,
  options: CapabilityOptions = {},
): Promise<Record<string, unknown>> {
  const request = String(args.request || "").trim();
  if (!request) return { status: "error", reason: "request_required" };
  if (request.length > 12000) return { status: "error", reason: "request_too_large" };

  const surface = args.surface || "chatgpt";
  const caller = options.turnContext?.senderIsOwner === true ? "owner" : "other";
  if (args.caller !== undefined && args.caller !== caller) {
    return { status: "error", reason: "caller_not_admitted" };
  }
  // A missing owner bit is never reconstructed from an agent/session name.
  if (options.turnContext?.senderIsOwner === undefined && args.execute !== false) {
    return { status: "error", reason: "caller_not_admitted" };
  }
  const execute = args.execute !== false;
  const timeout = Math.max(2, Math.min(Number(args.timeoutSeconds || 30), 120));
  const started=performance.now(),deadlineEpochMs=Date.now()+PUBLIC_WEB_BUDGET_MS;
  const nativeChannel=options.turnContext?.nativeChannelId,invocation=options.turnContext?.invocationId;
  const nativeIdentity=typeof nativeChannel==="string"&&nativeChannel.length>0&&nativeChannel.length<=512&&typeof invocation==="string"&&/^[A-Za-z0-9_.:-]{1,160}$/.test(invocation);
  const opaque=(kind:string,value:string)=>{
    const h=createHash("sha256").update(JSON.stringify(["claw-native-web-v1",kind,value])).digest("hex").slice(0,32);
    return h.slice(0,8)+"-"+h.slice(8,12)+"-5"+h.slice(13,16)+"-a"+h.slice(17,20)+"-"+h.slice(20);
  };
  const requestId=nativeIdentity?opaque("request",JSON.stringify([nativeChannel,invocation])):undefined;
  const sessionId=nativeIdentity?opaque("session",nativeChannel!):undefined;
  const helpers = options.helperPath ? [options.helperPath] : helperCandidates(options.home);
  let lastError = "helper_missing";

  for (const helper of helpers) {
    try {
      // 38 E3: the agent executes only through `agent-execute` (one canonical resolution, E3 policy,
      // then that exact decision in read-only mode). Operator or non-read decisions are never run here.
      const argv = [
        helper,
        execute ? "agent-execute" : "resolve",
        request,
        "--surface", surface,
        "--caller", caller,
      ];
      if (execute) argv.push("--timeout", String(timeout));
      const remaining=Math.floor(Math.min(PUBLIC_WEB_BUDGET_MS-(performance.now()-started),deadlineEpochMs-Date.now()));
      if(execute&&nativeIdentity){
        if(remaining<1)return {status:"error",reason:"web_deadline_exceeded"};
        argv.push("--request-id",requestId!,"--run-id",requestId!,"--session-id",sessionId!,"--remaining-budget-ms",String(remaining),"--deadline-epoch-ms",String(deadlineEpochMs));
      }
      try { options.turnContext?.assertInvocationCurrent?.(); }
      catch { return { status: "error", reason: "caller_not_admitted" }; }
      const raw: any = await runCapabilityHelperProcess(argv, {
        timeoutMs:execute&&nativeIdentity?remaining:(timeout+8)*1000,
        maxBuffer:2*1024*1024,env:{...process.env},killGroup:execute&&nativeIdentity,
      });
      const stdout = typeof raw === "string" ? raw : String(raw?.stdout ?? "");
      const stderr = typeof raw === "string" ? "" : String(raw?.stderr ?? "");
      const parsed = JSON.parse(stdout || "{}");
      if (typeof parsed !== "object" || parsed === null) {
        return { status: "error", reason: "invalid_result" };
      }
      if(parsed?.execution?.result?.web!==undefined){
        const web=readRunWebResult(parsed.execution.result.web);
        if(!web)return {status:"error",reason:"invalid_web_result"};
        if(execute&&nativeIdentity&&(performance.now()-started>=PUBLIC_WEB_BUDGET_MS||Date.now()>=deadlineEpochMs))return {status:"error",reason:"web_deadline_exceeded"};
        return {status:"ok",...parsed,execution:{...parsed.execution,result:{web}}};
      }
      if (parsed?.execution?.reason === AGENT_CAPABILITY_REFUSAL) {
        return {
          status: "error",
          reason: AGENT_CAPABILITY_REFUSAL,
          executed: false,
          capability: parsed.capability ?? null,
          agent_policy: parsed.agent_policy ?? null,
          message: "Demande opérateur ou transaction : elle passe par l'entrée Samantha avec le texte original de l'utilisateur, jamais par l'agent. N'affirme aucun résultat.",
        };
      }
      return {
        status: "ok",
        ...parsed,
        ...(stderr?.trim() ? { runtimeWarning: stderr.trim().slice(0, 800) } : {}),
      };
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        lastError = "helper_missing";
        continue;
      }
      const stdout = typeof error?.stdout === "string" ? error.stdout : "";
      try {
        const parsed = JSON.parse(stdout || "{}");
        if (parsed && typeof parsed === "object") return { status: "error", ...parsed };
      } catch {}
      lastError = execute&&nativeIdentity&&Date.now()>=deadlineEpochMs?"web_deadline_exceeded":"helper_failed";
      break;
    }
  }
  return { status: "error", reason: lastError };
}
