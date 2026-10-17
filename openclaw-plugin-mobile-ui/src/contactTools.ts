import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { contactRoomSession } from "./contactRoomProfile";

type ToolKind = "transmettre_a_amine" | "noter_contact";

function caller(ctx: any) {
  const match = contactRoomSession(ctx?.sessionKey);
  if (!match || (ctx?.agentId && ctx.agentId !== match.agent)) return null;
  return { agent: match.agent, e164: match.e164 };
}

function helper(home = os.homedir()) {
  return process.env.SAMANTHA_PEOPLE_TRUSTED || path.join(home, ".openclaw/releases/current/termux-lite/people-trusted.py");
}

async function invoke(kind: ToolKind, ctx: any, args: any): Promise<any> {
  const current = caller(ctx);
  if (!current) return { success: false, state: "refused", reason: "contact_tool_not_allowed" };
  const text = typeof args?.text === "string" ? args.text.trim() : "";
  if (!text || Array.from(text).length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    return { success: false, state: "refused", reason: "invalid_request" };
  const origin = String(ctx?.messageId || ctx?.runId || ctx?.sessionKey || "contact");
  const operationId = `contact:${kind}:${crypto.createHash("sha256").update(origin + "\0" + text).digest("hex").slice(0, 32)}`;
  return new Promise((resolve) => {
    const child = spawn("python3", [helper(), "allowlist", "contact-tool"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", size = 0, settled = false;
    const done = (value: any) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill(); done({ success: false, state: "indeterminate", reason: "contact_tool_unavailable" }); }, 20_000);
    child.stdout.on("data", chunk => { size += chunk.length; if (size > 131_072) { child.kill(); done({ success: false, state: "indeterminate", reason: "contact_tool_unavailable" }); } else output += chunk; });
    child.stderr.resume();
    child.on("error", () => done({ success: false, state: "failed", reason: "contact_tool_unavailable" }));
    child.on("close", code => {
      try {
        const value = JSON.parse(output || "{}");
        if (code !== 0 || typeof value?.success !== "boolean") throw Error();
        done(value);
      } catch { done({ success: false, state: "indeterminate", reason: "contact_tool_unavailable" }); }
    });
    child.stdin.on("error", () => done({ success: false, state: "failed", reason: "contact_tool_unavailable" }));
    child.stdin.end(JSON.stringify({ action: kind, operationId, e164: current.e164, text }));
  });
}

function content(value: any) { return { content: [{ type: "text", text: JSON.stringify(value) }] }; }

export function createContactTool(kind: ToolKind, ctx: any) {
  return {
    name: kind,
    description: kind === "transmettre_a_amine"
      ? "Transmettre un message bref à Amine. Ajoute uniquement à son inbox et le notifie; ne lit aucune donnée."
      : "Noter une information dans votre propre fiche de contact seulement.",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 2000 },
      },
      required: ["text"], additionalProperties: false,
    },
    async execute(_toolCallId: unknown, args: any) { return content(await invoke(kind, ctx, args)); },
  };
}

export const contactToolCaller = caller;
