import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_MESSAGE_CHARS = 2000;

type FastPathResult = {
  status?: string;
  text?: string;
  reason?: string;
  target?: string;
  intent?: string;
  route?: string;
};

type InboundEvent = {
  content?: string;
  bodyForAgent?: string;
  isGroup?: boolean;
  senderIsOwner?: boolean;
  media?: unknown[];
  originalMedia?: unknown[];
  sessionKey?: string;
};

type InboundContext = {
  agentId?: string;
  sessionKey?: string;
};

function helperCandidates(home = os.homedir()): string[] {
  return [
    path.join(home, ".openclaw/releases/current/termux-lite/model-fast-path.py"),
    path.join(home, "ClawMobile/installer/termux-lite/model-fast-path.py"),
  ];
}

function isMainSession(event: InboundEvent, ctx: InboundContext): boolean {
  if (ctx.agentId) return ctx.agentId === "main";
  const key = ctx.sessionKey ?? event.sessionKey ?? "";
  return key.startsWith("agent:main:");
}

export function isOwnerFastPathEligible(
  event: InboundEvent,
  ctx: InboundContext,
): boolean {
  if (event.senderIsOwner !== true || event.isGroup === true) return false;
  if (!isMainSession(event, ctx)) return false;
  if ((event.media?.length ?? 0) > 0 || (event.originalMedia?.length ?? 0) > 0) {
    return false;
  }
  const message = (event.bodyForAgent ?? event.content ?? "").trim();
  return message.length > 0 && message.length <= MAX_MESSAGE_CHARS;
}

export async function runModelFastPath(
  message: string,
  options: { helperPath?: string; home?: string } = {},
): Promise<FastPathResult> {
  const helpers = options.helperPath
    ? [options.helperPath]
    : helperCandidates(options.home);
  let lastError = "helper_missing";
  for (const helper of helpers) {
    try {
      const { stdout } = await execFileAsync(
        "python3",
        [helper, message],
        {
          timeout: 25000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env },
        },
      );
      const parsed = JSON.parse(stdout || "{}");
      return typeof parsed === "object" && parsed !== null
        ? parsed as FastPathResult
        : { status: "error", reason: "invalid_result" };
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        lastError = "helper_missing";
        continue;
      }
      lastError = "helper_failed";
      break;
    }
  }
  return { status: "error", reason: lastError };
}

export async function handleOwnerFastPath(
  event: InboundEvent,
  ctx: InboundContext,
  runner: (message: string) => Promise<FastPathResult> = runModelFastPath,
): Promise<{ handled: boolean; reply?: { text: string } }> {
  if (!isOwnerFastPathEligible(event, ctx)) return { handled: false };
  const message = (event.bodyForAgent ?? event.content ?? "").trim();
  try {
    const result = await runner(message);
    const text = typeof result.text === "string" ? result.text.trim() : "";
    if (result.status !== "hit" || !text) return { handled: false };
    return { handled: true, reply: { text } };
  } catch {
    return { handled: false };
  }
}
