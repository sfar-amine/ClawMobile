import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Hands a voice realignment round to the existing owner `engineering.learning_gate`
 * (`python3 -m skill_intelligence.improvement capture-round --surface voice`). No new store:
 * the owner writes its pending round and feeds improvements.db. The payload carries no
 * transcript and no secret; the owner validates it again (round_learning.normalize).
 */

export type RoundCaptureResult = { state: string; receipt_id?: string; duplicate?: boolean; learning_outcome?: string; reason?: string };
export type RoundCaptureRunner = (payload: Record<string, unknown>) => Promise<RoundCaptureResult>;

/** Same playbooks root resolution as claw-capability.py (pinned snapshot before the workspace). */
export function playbooksRoot(home = os.homedir()): string | null {
  const candidates = [
    process.env.CLAW_UI_PLAYBOOKS_ROOT || "",
    path.join(home, ".openclaw/runtime-ui-playbooks/current"),
    path.join(home, ".openclaw/workspace/ui-playbooks"),
  ].filter(Boolean);
  for (const root of candidates) {
    try { if (fs.statSync(path.join(root, "skill_intelligence/improvement.py")).isFile()) return root; } catch {}
  }
  return null;
}

const TIMEOUT_MS = 4_000;

export const captureVoiceRound: RoundCaptureRunner = (payload) => new Promise((resolve) => {
  const root = playbooksRoot();
  if (!root) { resolve({ state: "skipped", reason: "learning_gate_unavailable" }); return; }
  const raw = JSON.stringify(payload);
  if (Buffer.byteLength(raw) > 8192) { resolve({ state: "skipped", reason: "round_payload_too_large" }); return; }
  const env = { ...process.env, PYTHONPATH: root + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : "") };
  const child = execFile(process.env.CLAW_PYTHON || "python3", ["-B", "-m", "skill_intelligence.improvement", "capture-round", "--surface", "voice"],
    { cwd: root, env, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout) => {
      let parsed: any = null;
      try { parsed = JSON.parse(String(stdout || "").trim().split("\n").pop() || "null"); } catch {}
      if (parsed && typeof parsed === "object" && typeof parsed.state === "string") {
        resolve({ state: parsed.state, receipt_id: typeof parsed.receipt_id === "string" ? parsed.receipt_id : undefined,
          duplicate: parsed.duplicate === true, learning_outcome: typeof parsed.learning_outcome === "string" ? parsed.learning_outcome : undefined });
        return;
      }
      // Never surface stderr (it may echo input); a closed reason only.
      resolve({ state: "attention_required", reason: (error as any)?.killed ? "learning_capture_timeout" : "learning_capture_failed" });
    });
  child.stdin?.end(raw);
});
