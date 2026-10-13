import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { AGENT_CAPABILITY_REFUSAL } from "./capabilityAgentGuard";

const execFileAsync = promisify(execFile);

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
  assertInvocationCurrent?: () => void;
};

type CapabilityOptions = { helperPath?: string; home?: string; turnContext?: CapabilityTurnContext };

export function createCapabilityTool(context: CapabilityTurnContext, options: Omit<CapabilityOptions, "turnContext"> = {}) {
  // Snapshot the host bit for this factory invocation, not a session-wide identity.
  const turnContext = {
    senderIsOwner: context?.senderIsOwner,
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
      const result = await clawmobile_capability(args ?? {}, { ...options, turnContext });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  };
}

function helperCandidates(home = os.homedir()): string[] {
  return [
    path.join(home, ".openclaw/releases/current/termux-lite/claw-capability.py"),
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
      try { options.turnContext?.assertInvocationCurrent?.(); }
      catch { return { status: "error", reason: "caller_not_admitted" }; }
      const raw: any = await execFileAsync("python3", argv, {
        timeout: (timeout + 8) * 1000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env },
      });
      const stdout = typeof raw === "string" ? raw : String(raw?.stdout ?? "");
      const stderr = typeof raw === "string" ? "" : String(raw?.stderr ?? "");
      const parsed = JSON.parse(stdout || "{}");
      if (typeof parsed !== "object" || parsed === null) {
        return { status: "error", reason: "invalid_result" };
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
      lastError = String(error?.message || "helper_failed").slice(0, 800);
      break;
    }
  }
  return { status: "error", reason: lastError };
}
