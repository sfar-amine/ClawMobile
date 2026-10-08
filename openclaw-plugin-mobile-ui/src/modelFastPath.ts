import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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
  model_bypassed?: boolean;
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

type RunnerOptions = {
  helperPath?: string;
  home?: string;
  surface?: string;
  caller?: "owner" | "trusted" | "other";
  originId?: string;
  timeoutSeconds?: number;
  checkOnly?: boolean;
};

function helperCandidates(home = os.homedir()): string[] {
  return [
    process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER || "",
    path.join(home, ".openclaw/releases/current/termux-lite/model-fast-path.py"),
    path.join(home, "ClawMobile/installer/termux-lite/model-fast-path.py"),
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

export async function runModelFastPath(
  message: string,
  options: RunnerOptions = {},
): Promise<FastPathResult> {
  const helpers = options.helperPath
    ? [options.helperPath]
    : helperCandidates(options.home);
  let lastError = "helper_missing";
  for (const helper of helpers) {
    try {
      const argv = [
        ...(options.checkOnly ? ["--check"] : []),
        "--surface", options.surface || "claw_live",
        "--caller", options.caller || "owner",
        "--origin-id", options.originId || "capability-first",
        "--timeout", String(Math.max(2, Math.min(options.timeoutSeconds || 30, 120))),
        message,
      ];
      const raw: any = await execFileAsync(
        "python3",
        [helper, ...argv],
        {
          timeout: (Math.max(2, Math.min(options.timeoutSeconds || 30, 120)) + 8) * 1000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env },
        },
      );
      const stdout = typeof raw === "string" ? raw : String(raw?.stdout ?? "");
      const parsed = JSON.parse(stdout || "{}");
      return typeof parsed === "object" && parsed !== null
        ? parsed as FastPathResult
        : { status: "error", reason: "invalid_result" };
    } catch (error: any) {
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

export async function handleOwnerFastPath(
  event: InboundEvent,
  ctx: InboundContext,
  runner: (message: string, options?: RunnerOptions) => Promise<FastPathResult> = runModelFastPath,
): Promise<{ handled: boolean; reply?: { text: string } }> {
  if (!isOwnerFastPathEligible(event, ctx)) return { handled: false };
  const message = (event.bodyForAgent ?? event.content ?? "").trim();
  try {
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
    return { handled: false };
  } catch {
    return { handled: false };
  }
}
