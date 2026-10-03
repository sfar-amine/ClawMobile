import { execFile as execFileCb } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFile = promisify(execFileCb);
const TURN_TTL_MS = 5 * 60 * 1000;
const GOOGLE_FALLBACK_SESSION_PREFIX = "agent:gemini:channel-provider-fallback-";

type TurnState = {
  prompt: string;
  sessionKey: string;
  createdAt: number;
  toolCalled: boolean;
  openAiFailure: boolean;
};

type GeminiResult = {
  status?: string;
  text?: string;
  provider?: string | null;
  model?: string | null;
  rerouted?: boolean;
  reported_cost_usd?: number;
};

export function normalizePhone(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

function directWhatsAppPeer(sessionKey: unknown): string {
  if (typeof sessionKey !== "string") return "";
  const match = sessionKey.match(/:whatsapp:direct:(\+?\d+)/i);
  return normalizePhone(match?.[1] || "");
}

function allowedWhatsAppPeers(cfg: any): Set<string> {
  const result = new Set<string>();
  const root = cfg?.channels?.whatsapp || {};
  const add = (values: unknown) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      const normalized = normalizePhone(value);
      if (normalized) result.add(normalized);
    }
  };
  add(root.allowFrom);
  for (const account of Object.values(root.accounts || {})) {
    add((account as any)?.allowFrom);
  }
  return result;
}

export function isEligibleTrustedWhatsApp(ctx: any, cfg: any): boolean {
  if (ctx?.agentId !== "main") return false;
  if (ctx?.trigger && ctx.trigger !== "user") return false;
  const channel = String(ctx?.channel || ctx?.messageProvider || "").toLowerCase();
  const sessionKey = String(ctx?.sessionKey || "");
  if (channel && channel !== "whatsapp" && !sessionKey.includes(":whatsapp:")) return false;
  const peer = directWhatsAppPeer(sessionKey);
  return Boolean(peer && allowedWhatsAppPeers(cfg).has(peer));
}

export function isOpenAiTerminalError(content: unknown): boolean {
  if (typeof content !== "string") return false;
  const text = content.toLowerCase();
  return (
    text.includes("provider openai is in cooldown") ||
    text.includes("openai is asking us to slow down") ||
    text.includes("openai usage limit") ||
    text.includes("usage limit has been reached") ||
    text.includes("api rate limit reached") ||
    (text.includes("all models failed") && text.includes("openai/")) ||
    (text.includes("rate_limit") && text.includes("openai"))
  );
}

function stateKey(ctx: any, event?: any): string {
  return String(ctx?.runId || event?.runId || ctx?.sessionKey || "");
}

function safeSessionToken(sessionKey: string): string {
  return sessionKey.replace(/[^A-Za-z0-9._-]/g, "-").slice(-48) || "whatsapp";
}

async function runGeminiFallback(prompt: string, sessionKey: string): Promise<GeminiResult> {
  const script = join(homedir(), "ClawMobile", "installer", "termux-lite", "gemini-request.py");
  const { stdout } = await execFile(
    "python3",
    [
      script,
      "--provider-fallback",
      "--caller",
      "trusted",
      "--session",
      "provider-fallback-trusted-" + safeSessionToken(sessionKey),
      "--timeout",
      "45",
      prompt,
    ],
    { timeout: 70000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout || "{}");
}

export function createProviderFallbackCoordinator(
  api: any,
  runner: (prompt: string, sessionKey: string) => Promise<GeminiResult> = runGeminiFallback,
) {
  const turns = new Map<string, TurnState>();
  const sweep = () => {
    const cutoff = Date.now() - TURN_TTL_MS;
    for (const [key, state] of turns) {
      if (state.createdAt < cutoff) turns.delete(key);
    }
  };

  return {
    beforeModelResolve(event: any, ctx: any) {
      sweep();
      const key = stateKey(ctx, event);
      if (!key || !isEligibleTrustedWhatsApp(ctx, api.config)) return;
      if (Array.isArray(event?.attachments) && event.attachments.length > 0) return;
      const prompt = String(event?.prompt || "").trim();
      if (!prompt) return;
      turns.set(key, {
        prompt,
        sessionKey: String(ctx?.sessionKey || ""),
        createdAt: Date.now(),
        toolCalled: false,
        openAiFailure: false,
      });
    },

    modelCallEnded(event: any, ctx: any) {
      const state = turns.get(stateKey(ctx, event));
      if (
        state &&
        String(event?.provider || "").toLowerCase() === "openai" &&
        event?.outcome === "error"
      ) {
        state.openAiFailure = true;
      }
    },

    beforeToolCall(event: any, ctx: any) {
      const state = turns.get(stateKey(ctx, event));
      if (state) state.toolCalled = true;
    },

    beforePromptBuild(_event: any, ctx: any) {
      const sessionKey = String(ctx?.sessionKey || "");
      if (
        ctx?.agentId === "gemini" &&
        sessionKey.startsWith(GOOGLE_FALLBACK_SESSION_PREFIX)
      ) {
        return { toolsAllow: [] };
      }
    },

    async beforeAgentReply(event: any, ctx: any) {
      const key = stateKey(ctx, event);
      const state = turns.get(key);
      if (!state) return;

      const body = String(event?.cleanedBody || "");
      if (!isOpenAiTerminalError(body)) {
        turns.delete(key);
        return;
      }

      if (state.toolCalled) {
        api.logger?.warn?.("[provider-fallback] Gemini skipped: turn already executed a tool");
        turns.delete(key);
        return;
      }

      if (!state.openAiFailure && !body.toLowerCase().includes("cooldown")) {
        turns.delete(key);
        return;
      }

      try {
        const result = await runner(state.prompt, state.sessionKey);
        const text = String(result?.text || "").trim();
        const safe =
          result?.status === "ok" &&
          Boolean(text) &&
          result?.provider === "google" &&
          result?.rerouted !== true &&
          Number(result?.reported_cost_usd || 0) === 0;
        if (!safe) {
          api.logger?.warn?.("[provider-fallback] Gemini result rejected by free/safety contract");
          return;
        }
        api.logger?.warn?.(
          "[provider-fallback] OpenAI exhausted; recovered with Google Free Tier answer-only fallback",
        );
        return {
          handled: true,
          reply: { text },
          reason: "provider_fallback_google_free",
        };
      } catch (error) {
        api.logger?.warn?.("[provider-fallback] Google fallback unavailable: " + String(error));
        return;
      } finally {
        turns.delete(key);
      }
    },

    _stateSize() {
      return turns.size;
    },
  };
}
