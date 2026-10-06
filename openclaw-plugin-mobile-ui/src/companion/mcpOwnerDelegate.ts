import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

function responseText(envelope: any) {
  const result = envelope?.result || envelope || {};
  const payloads = Array.isArray(result?.payloads) ? result.payloads : [];
  const text = payloads
    .filter((row: any) => row && typeof row === "object" && typeof row.text === "string")
    .map((row: any) => row.text)
    .join("\n")
    .trim();
  if (text) return text.slice(0, 48000);
  if (typeof result?.text === "string") return result.text.slice(0, 48000);
  return "";
}

export async function delegateMcpOwnerRequest(
  request: string,
  requestId: string,
  capability: string,
) {
  const helper = String(
    process.env.CLAWMOBILE_MCP_OWNER_DELEGATE_HELPER ||
    path.join(os.homedir(), "ClawMobile", "installer", "termux-lite", "gateway-secretref-exec.sh"),
  ).trim();
  const agent = String(process.env.CLAWMOBILE_MCP_OWNER_DELEGATE_AGENT || "main").trim();
  if (!helper || !fs.existsSync(helper)) {
    return {
      state: "failed",
      executor: "openclaw.agent.main",
      capability,
      delegated: true,
      result: { ok: false, state: "delegation_unavailable", reason: "owner_delegate_helper_missing" },
    };
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(agent)) throw new Error("invalid_owner_delegate_agent");

  const digest = crypto.createHash("sha256").update(requestId).digest("hex").slice(0, 32);
  const sessionKey = `agent:${agent}:mcp-${digest}`;
  const message = [
    "External MCP owner request.",
    "Use the canonical Claw/S24 capabilities and current workspace rules to complete it.",
    "Keep all normal confirmation, verification, idempotence and human-presence boundaries.",
    "Do not deliver a reply to any external channel unless the original owner request explicitly requires that effect.",
    capability ? `Resolved capability hint: ${capability}.` : "",
    "Return the verified result to the caller.",
    `OWNER_REQUEST=${request}`,
  ].filter(Boolean).join("\n");

  try {
    const raw: any = await execFileAsync(helper, [
      "agent",
      "--agent", agent,
      "--session-key", sessionKey,
      "--message", message,
      "--timeout", "120",
      "--json",
    ], {
      timeout: 135000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env },
    });
    const stdout = typeof raw === "string" ? raw : String(raw?.stdout ?? "");
    const envelope = JSON.parse(stdout || "{}");
    const text = responseText(envelope);
    if (envelope?.ok === false || envelope?.error || !text) {
      return {
        state: "failed",
        executor: `openclaw.agent.${agent}`,
        capability,
        delegated: true,
        result: { ok: false, state: "delegation_failed", reason: "owner_delegate_failed" },
      };
    }
    return {
      state: "completed",
      executor: `openclaw.agent.${agent}`,
      capability,
      delegated: true,
      result: { ok: true, state: "completed", delegated: true, text },
    };
  } catch (error: any) {
    return {
      state: "failed",
      executor: `openclaw.agent.${agent}`,
      capability,
      delegated: true,
      result: {
        ok: false,
        state: "delegation_failed",
        reason: String(error?.code || error?.name || "owner_delegate_failed").slice(0, 120),
      },
    };
  }
}
