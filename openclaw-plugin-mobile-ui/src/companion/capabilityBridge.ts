import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function helpers(home = os.homedir()): string[] {
  const configured = String(process.env.CLAW_CAPABILITY_HELPER || "").trim();
  return [
    configured,
    path.join(home, ".openclaw/releases/current/termux-lite/claw-capability.py"),
    path.join(home, "ClawMobile/installer/termux-lite/claw-capability.py"),
  ].filter(Boolean);
}

export async function capabilityBridge(
  request: string,
  options: {
    execute?: boolean;
    readOnly?: boolean;
    surface?: string;
    caller?: string;
    timeoutSeconds?: number;
    targetHint?: string;
    helperPath?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const text = String(request || "").trim();
  if (!text) return { success: false, error: "request_required" };
  if (text.length > 12000) return { success: false, error: "request_too_large" };

  const execute = options.execute === true;
  const surface = String(options.surface || "bixby");
  const caller = String(options.caller || "owner");
  const targetHint = String(options.targetHint || "").trim();
  if (targetHint && !/^[A-Za-z0-9._-]{1,128}$/.test(targetHint)) {
    return { success: false, error: "invalid_target_hint" };
  }
  const timeout = Math.max(2, Math.min(Number(options.timeoutSeconds || 30), 120));
  const candidates = options.helperPath ? [options.helperPath] : helpers();

  for (const helper of candidates) {
    try {
      const argv = [
        helper,
        execute ? "execute" : "resolve",
        text,
        "--surface", surface,
        "--caller", caller,
      ];
      if (targetHint) argv.push("--target", targetHint);
      if (execute) argv.push("--timeout", String(timeout));
      if (execute && options.readOnly === true) argv.push("--read-only");
      const raw: any = await execFileAsync("python3", argv, {
        timeout: (timeout + 8) * 1000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env },
      });
      const stdout = typeof raw === "string" ? raw : String(raw?.stdout ?? "");
      const parsed = JSON.parse(stdout || "{}");
      return { success: true, ...parsed };
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      const stdout = typeof error?.stdout === "string" ? error.stdout : "";
      try {
        const parsed = JSON.parse(stdout || "{}");
        return { success: false, ...parsed };
      } catch {}
      return { success: false, error: String(error?.message || "capability_bridge_failed").slice(0, 800) };
    }
  }
  return { success: false, error: "capability_bridge_unavailable" };
}
