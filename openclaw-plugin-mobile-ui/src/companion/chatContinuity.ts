import fs from "fs";
import os from "os";
import path from "path";

export type ChatMode = "text" | "voice";
export type ContinuityCheckpoint = {
  version: 1;
  conversationId: string;
  mode: ChatMode;
  lastSeenAt: string;
  restore: "ready" | "pending" | "restoring";
  source?: string;
};

const dir = path.join(os.homedir(), ".openclaw", "continuity");
const file = path.join(dir, "chatgpt-current.json");

function validId(id: string) {
  return /^[A-Za-z0-9_-]{8,200}$/.test(id);
}

export function readChatContinuity(): ContinuityCheckpoint | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    if (v?.version !== 1 || !validId(String(v.conversationId || ""))) return null;
    if (v.mode !== "text" && v.mode !== "voice") return null;
    return v as ContinuityCheckpoint;
  } catch { return null; }
}

export function checkpointChatConversation(conversationId: string, mode: ChatMode, source = "runtime") {
  if (!validId(conversationId)) throw new Error("Invalid ChatGPT conversation identifier.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const value: ContinuityCheckpoint = {
    version: 1, conversationId, mode, lastSeenAt: new Date().toISOString(), restore: "ready", source,
  };
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return value;
}

export function markChatRestore(state: ContinuityCheckpoint["restore"]) {
  const current = readChatContinuity();
  if (!current) return null;
  const next = { ...current, restore: state, lastSeenAt: new Date().toISOString() };
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

export function chatConversationUrl(id: string) {
  if (!validId(id)) throw new Error("Invalid ChatGPT conversation identifier.");
  return "https://chatgpt.com/c/" + encodeURIComponent(id);
}
