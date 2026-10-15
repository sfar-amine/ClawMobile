import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SurfaceClarifications } from "./capabilityClarification";

const execFileAsync = promisify(execFile);
const MAX_MESSAGE_CHARS = 12000;
const LOCAL_COMPANION_SESSION = /^agent:main:companion-chat-[A-Za-z0-9-]{1,96}$/;

export type FastPathResult = {
  status?: string;
  text?: string;
  reason?: string;
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
  helperPath?: string;
  home?: string;
  surface?: string;
  caller?: "owner" | "trusted" | "other";
  originId?: string;
  timeoutSeconds?: number;
  checkOnly?: boolean;
  /** Optional total budget for read-only checks; never valid for dispatch. */
  checkBudgetMs?: number;
  preparedDecision?: Record<string, unknown>;
  clarificationDecision?: Record<string, unknown>;
  clarificationOriginalText?: string;
};

function helperCandidates(home = os.homedir()): string[] {
  return [
    process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER || "",
    path.join(home, ".openclaw/releases/current/termux-lite/model-fast-path.py"),
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

function originId(event: InboundEvent, ctx: InboundContext): string {
  return String(
    ctx.runId ||
    event.runId ||
    event.idempotencyKey ||
    event.id ||
    ctx.sessionKey ||
    event.sessionKey ||
    "capability-first",
  ).slice(0, 120);
}

/** O6 (fichier 37) : a guarded operator read holds Wi-Fi off for at most 60 s; the helper waits up to 70 s for it.
 * An executing call is never killed before that wait (+ 15 s for resolution and process start). Other routes stay
 * bounded by the helper's own budget; a check-only call keeps its short budget. */
export const GUARDED_ENTRY_WAIT_S = 70;
export function fastPathProcessTimeoutMs(timeoutSeconds: number, checkOnly: boolean): number {
  return checkOnly ? (timeoutSeconds + 8) * 1000 : (Math.max(timeoutSeconds, GUARDED_ENTRY_WAIT_S) + 15) * 1000;
}

export async function runModelFastPath(
  message: string,
  options: RunnerOptions = {},
): Promise<FastPathResult> {
  if(options.checkBudgetMs!==undefined&&(!options.checkOnly||!Number.isSafeInteger(options.checkBudgetMs)||options.checkBudgetMs<1||options.checkBudgetMs>10000))return {status:"error",reason:"invalid_check_budget"};
  const deadline=options.checkBudgetMs===undefined?undefined:Date.now()+options.checkBudgetMs;
  const helpers = options.helperPath
    ? [options.helperPath]
    : helperCandidates(options.home);
  let lastError = "helper_missing";
  for (const helper of helpers) {
    const remaining=deadline===undefined?undefined:deadline-Date.now();
    if(remaining!==undefined&&remaining<=0)return {status:"error",reason:"check_budget_exceeded"};
    try {
      const argv = [
        ...(options.clarificationDecision ? ["--resolve-clarification"] : options.preparedDecision ? ["--execute-decision"] : []),
        ...(options.checkOnly ? ["--check"] : []),
        "--surface", options.surface || "claw_live",
        "--caller", options.caller || "owner",
        "--origin-id", options.originId || "capability-first",
        "--timeout", String(Math.max(2, Math.min(options.timeoutSeconds || 30, 120))),
        message,
      ];
      const timeoutSeconds = Math.max(2, Math.min(options.timeoutSeconds || 30, 120));
      const raw: any = await execFileAsync(
        "python3",
        [helper, ...argv],
        {
          timeout: Math.min(fastPathProcessTimeoutMs(timeoutSeconds, !!options.checkOnly),remaining ?? Infinity),
          ...(remaining!==undefined?{killSignal:"SIGKILL" as const}:{}),
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...process.env,
            ...((options.preparedDecision || options.clarificationDecision) ? {
              CLAW_PREPARED_DECISION_B64: Buffer.from(JSON.stringify(options.preparedDecision || options.clarificationDecision), "utf8").toString("base64"),
            } : {}),
            ...(options.clarificationDecision ? {
              CLAW_CLARIFICATION_ORIGINAL_B64: Buffer.from(String(options.clarificationOriginalText || ""), "utf8").toString("base64"),
            } : {}),
          },
        },
      );
      const stdout = typeof raw === "string" ? raw : String(raw?.stdout ?? "");
      const parsed = JSON.parse(stdout || "{}");
      return typeof parsed === "object" && parsed !== null
        ? parsed as FastPathResult
        : { status: "error", reason: "invalid_result" };
    } catch (error: any) {
      if(deadline!==undefined&&(Date.now()>=deadline||error?.killed))return {status:"error",reason:"check_budget_exceeded"};
      if (error?.code === "ENOENT") {
        lastError = "helper_missing";
        continue;
      }
      const stdout = typeof error?.stdout === "string" ? error.stdout : "";
      try {
        const parsed = JSON.parse(stdout || "{}");
        if (parsed && typeof parsed === "object") return parsed as FastPathResult;
      } catch {}
      lastError = "helper_failed";
      break;
    }
  }
  return { status: "error", reason: lastError };
}

let whatsappClarifications: SurfaceClarifications | null = null;

/** Exposed for tests: the bounded pending CLARIFY questions of inbound (WhatsApp) conversations. */
export function inboundClarifications(runner: (message: string, options?: RunnerOptions) => Promise<FastPathResult> = runModelFastPath) {
  if (!whatsappClarifications) whatsappClarifications = new SurfaceClarifications(runner);
  return whatsappClarifications;
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
  event: { messageId?: string; content?: string; body?: string; channel?: string; sessionKey?: string; isGroup?: boolean },
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
    { content: event?.content || event?.body, senderIsOwner: true, isGroup: false, sessionKey },
    { agentId: "main", sessionKey, channel: "whatsapp", runId: event?.messageId ?? ctx?.messageId },
    runner,
  );
  return out.handled ? { handled: true, text: out.reply?.text } : { handled: false };
}

export async function handleOwnerFastPath(
  event: InboundEvent,
  ctx: InboundContext,
  runner: (message: string, options?: RunnerOptions) => Promise<FastPathResult> = runModelFastPath,
  clarifications: SurfaceClarifications = runner === runModelFastPath ? inboundClarifications() : new SurfaceClarifications(runner),
): Promise<{ handled: boolean; reply?: { text: string } }> {
  if (!isOwnerFastPathEligible(event, ctx)) return { handled: false };
  const message = (event.bodyForAgent ?? event.content ?? "").trim();
  try {
    const id = SurfaceClarifications.idFor(conversationKey(event, ctx));
    // 38 E3: a pending CLARIFY of this conversation is answered through resolve-clarification.
    if (clarifications.hasPending(id)) {
      const turn = await clarifications.turn(message, { surface: surfaceFor(ctx), id, originId: originId(event, ctx), timeoutSeconds: 30 });
      if (turn.state === "needs_clarification") return { handled: true, reply: { text: turn.question } };
      if (turn.state === "done" || turn.state === "failed") return { handled: true, reply: { text: turn.text } };
      // Resolved but not deterministic: the agent continues in the same session (question + answer).
      return { handled: false };
    }
    const result = await runner(message, {
      surface: surfaceFor(ctx),
      caller: "owner",
      originId: originId(event, ctx),
      timeoutSeconds: 30,
    });
    const text = typeof result.text === "string" ? result.text.trim() : "";
    if ((result.status === "hit" || result.status === "known_error") && text) {
      return { handled: true, reply: { text } };
    }
    if (result.status === "clarification" && result.decision) {
      // Same question on every surface; the answer comes back through resolve-clarification.
      const question = text || String((result.clarification as any)?.question || "Précise ce que tu veux faire.");
      if (clarifications.hold(id, message, result.decision, surfaceFor(ctx))) return { handled: true, reply: { text: question } };
    }
    return { handled: false };
  } catch {
    return { handled: false };
  }
}
