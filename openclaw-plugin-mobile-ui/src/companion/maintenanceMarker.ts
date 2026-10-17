import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * SAM-MIG V2.2 §12.1 — READ-ONLY view of the durable maintenance marker for the stateless MCP adapter.
 *
 * The only writer is `installer/termux-lite/companion-deploy.sh --maintenance`. The MCP adapter reads the marker
 * directly (not through the dialogue coordinator) so that the lock stays fail-closed when the coordinator is
 * unreachable (T-X05: bounded error, no fallback). Semantics are those of the Python reader
 * (`skill_intelligence/dialogue/maintenance.py`): absent = open (epoch 0); unreadable or malformed = closed with a
 * reason; closed = refused, except for the acceptance conversations listed by `--allow conv-…` (B-14).
 */
export type MaintenanceGate =
  | { state: "open"; epoch: number }
  | { state: "acceptance"; epoch: number }
  | { state: "closed"; epoch: number | null; reason: "maintenance" | "maintenance_marker_unreadable" | "maintenance_marker_invalid" };

export function maintenanceMarkerPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const dir = env.CLAW_DIALOGUE_HOME ? String(env.CLAW_DIALOGUE_HOME) : path.join(home, ".openclaw", "samantha-dialogue");
  return path.join(dir, "maintenance.json");
}

/** Same reference as `skill_intelligence/dialogue/model.py::conversation_ref("mcp", key)`. */
export function mcpConversationRef(clientId: string): string {
  const raw = JSON.stringify(["dialogue-conversation-v1", "mcp", String(clientId).trim()]);
  return "conv-" + crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 24);
}

export function readMaintenanceGate(clientId?: string, file: string = maintenanceMarkerPath()): MaintenanceGate {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return { state: "open", epoch: 0 };
    return { state: "closed", epoch: null, reason: "maintenance_marker_unreadable" };
  }
  let value: any;
  try { value = JSON.parse(raw); } catch { return { state: "closed", epoch: null, reason: "maintenance_marker_invalid" }; }
  const epoch = Number(value?.epoch);
  const changed = Number(value?.changedAt);
  const acceptance = value?.acceptance ?? [];
  if (!value || !["open", "closed"].includes(value.state) || !Number.isInteger(epoch) || epoch < 0 ||
      !Number.isFinite(changed) || changed <= 0 || !Array.isArray(acceptance) ||
      !acceptance.every((x: unknown) => typeof x === "string" && x.startsWith("conv-"))) {
    return { state: "closed", epoch: Number.isInteger(epoch) ? epoch : null, reason: "maintenance_marker_invalid" };
  }
  if (value.state === "open") return { state: "open", epoch };
  if (clientId && acceptance.includes(mcpConversationRef(clientId))) return { state: "acceptance", epoch };
  return { state: "closed", epoch, reason: "maintenance" };
}
