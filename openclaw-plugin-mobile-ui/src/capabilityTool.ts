import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CapabilityArgs = {
  request?: string;
  execute?: boolean;
  surface?: "chatgpt" | "gemini_claw" | "gemini_live" | "bixby" | "whatsapp";
  caller?: "owner" | "trusted" | "other";
  timeoutSeconds?: number;
};

function helperCandidates(home = os.homedir()): string[] {
  return [
    path.join(home, ".openclaw/releases/current/termux-lite/claw-capability.py"),
    path.join(home, "ClawMobile/installer/termux-lite/claw-capability.py"),
  ];
}

export async function clawmobile_capability(
  args: CapabilityArgs,
  options: { helperPath?: string; home?: string } = {},
): Promise<Record<string, unknown>> {
  const request = String(args.request || "").trim();
  if (!request) return { status: "error", reason: "request_required" };
  if (request.length > 12000) return { status: "error", reason: "request_too_large" };

  const surface = args.surface || "chatgpt";
  const caller = args.caller || "owner";
  const execute = args.execute !== false;
  const timeout = Math.max(2, Math.min(Number(args.timeoutSeconds || 30), 120));
  const helpers = options.helperPath ? [options.helperPath] : helperCandidates(options.home);
  let lastError = "helper_missing";

  for (const helper of helpers) {
    try {
      const argv = [
        helper,
        execute ? "execute" : "resolve",
        request,
        "--surface", surface,
        "--caller", caller,
      ];
      if (execute) argv.push("--timeout", String(timeout));
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
