import { adb_open_uri, adb_shell, adb_tap, adb_type, adb_ui_dump_xml } from "../backends/adb";
import { chatConversationUrl, readChatContinuity } from "./chatContinuity";

const CHATGPT_PACKAGE = "com.openai.chatgpt";
const DEFAULT_POLL_MS = 1_500;
const DEFAULT_LOSS_DEBOUNCE_MS = 4_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 15_000;
const DEFAULT_RECOVERY_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 1;
const DEFAULT_DEEP_LINK = "https://chatgpt.com/voice";
const DEFAULT_RECOVERY_PROMPT = "Reprise automatique apres coupure. Dis uniquement : Amine, ça a coupé, je t’ai perdu. T’es toujours là ?";
const DEFAULT_RESUME_DELAY_MS = 1_500;
const DEFAULT_RECOVERY_PHRASE = "Amine, ça a coupé, je t’ai perdu. T’es toujours là ?";

type VoiceRecoveryState =
  | "disabled"
  | "idle"
  | "active"
  | "loss_suspected"
  | "recovering"
  | "verifying"
  | "cooldown"
  | "suspended";

export type VoiceRecoveryStatus = {
  enabled: boolean;
  state: VoiceRecoveryState;
  voiceActive: boolean;
  armed: boolean;
  lastObservedAt?: number;
  lastActiveAt?: number;
  lossStartedAt?: number;
  lastRecoveryAttemptAt?: number;
  lastRecoverySucceededAt?: number;
  intentionalStopUntil?: number;
  cooldownUntil?: number;
  recoveryAttempts: number;
  recoveryPending: boolean;
  recoveryPendingSince?: number;
  recoveryPhrase?: string;
  suspendedReason?: string;
  lastResumePromptAt?: number;
  lastResumePromptError?: string;
  lastError?: string;
};

let busy = false;
let timerStarted = false;
let status: VoiceRecoveryStatus = {
  enabled: false,
  state: "disabled",
  voiceActive: false,
  armed: false,
  recoveryAttempts: 0,
  recoveryPending: false,
};
function envMs(name: string, fallback: number, minimum: number) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function envInt(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

function enabled() {
  return process.env.CLAWMOBILE_VOICE_RECOVERY === "1";
}

export async function probeChatGptVoiceActive() {
  const result = await adb_shell({
    args: ["appops", "get", CHATGPT_PACKAGE, "RECORD_AUDIO"],
    timeoutMs: 8_000,
  });
  const text = `${result.stdout}\n${result.stderr}`;
  const voiceActive = result.ok && /RECORD_AUDIO:[^\n]*\(running\)/i.test(text);
  return {
    ok: result.ok,
    voiceActive,
    detail: text.trim().slice(0, 2_000),
  };
}

export function getVoiceRecoveryStatus(): VoiceRecoveryStatus {
  return { ...status };
}

function center(bounds: string) {
  const m = bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!m) return null;
  return { x: Math.round((Number(m[1]) + Number(m[3])) / 2), y: Math.round((Number(m[2]) + Number(m[4])) / 2) };
}

function nodeAttr(node: string, name: string) {
  return node.match(new RegExp(`${name}="([^"]*)"`))?.[1] || "";
}

async function injectRecoveryPrompt() {
  const delayMs = envMs("CLAWMOBILE_VOICE_RECOVERY_RESUME_DELAY_MS", DEFAULT_RESUME_DELAY_MS, 500);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  const dump = await adb_ui_dump_xml({ compressed: true, maxOutputBytes: 250_000 });
  if (!dump.ok || !dump.xml) throw new Error("Unable to inspect ChatGPT UI after voice recovery.");
  const nodes = dump.xml.match(/<node\b[^>]*>/g) || [];
  const edit = nodes.find((n) => nodeAttr(n, "package") === CHATGPT_PACKAGE && nodeAttr(n, "class") === "android.widget.EditText" && nodeAttr(n, "enabled") !== "false");
  if (!edit) throw new Error("ChatGPT reply field not found after voice recovery.");
  const editPoint = center(nodeAttr(edit, "bounds"));
  if (!editPoint) throw new Error("ChatGPT reply field bounds unavailable.");
  await adb_tap(editPoint);
  const prompt = process.env.CLAWMOBILE_VOICE_RECOVERY_PROMPT || DEFAULT_RECOVERY_PROMPT;
  const typed = await adb_type({ text: prompt });
  if (!typed.ok) throw new Error(typed.stderr || "Unable to type voice recovery prompt.");
  await new Promise((resolve) => setTimeout(resolve, 350));
  const after = await adb_ui_dump_xml({ compressed: true, maxOutputBytes: 250_000 });
  const afterNodes = after.xml?.match(/<node\b[^>]*>/g) || [];
  const activeEdit = afterNodes.find((n) => nodeAttr(n, "package") === CHATGPT_PACKAGE && nodeAttr(n, "class") === "android.widget.EditText" && nodeAttr(n, "text").includes("Reprise automatique"));
  if (!activeEdit) throw new Error("Recovery prompt was not present in ChatGPT reply field.");
  const eb = nodeAttr(activeEdit, "bounds").match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!eb) throw new Error("ChatGPT reply field bounds unavailable after typing.");
  const bottom = Number(eb[4]);
  const candidates = afterNodes
    .filter((n) => nodeAttr(n, "package") === CHATGPT_PACKAGE && nodeAttr(n, "clickable") === "true")
    .map((n) => ({ n, p: center(nodeAttr(n, "bounds")) }))
    .filter((v): v is { n: string; p: { x: number; y: number } } => Boolean(v.p))
    .filter((v) => v.p.x > 850 && v.p.y >= bottom && v.p.y <= bottom + 220)
    .sort((a, b) => b.p.x - a.p.x);
  const send = candidates[0];
  if (!send) throw new Error("ChatGPT send control not found after typing recovery prompt.");
  const tapped = await adb_tap(send.p);
  if (!tapped.ok) throw new Error(tapped.stderr || "Unable to submit voice recovery prompt.");
  status.lastResumePromptAt = Date.now();
  status.lastResumePromptError = undefined;
  status.recoveryPending = false;
}

async function deliverRecoveryPromptOnce() {
  if (!status.recoveryPending) return;
  try {
    await injectRecoveryPrompt();
    console.warn("[companion] submitted one-shot ChatGPT recovery prompt.");
  } catch (error: any) {
    status.lastResumePromptError = error?.message || String(error);
    status.recoveryPending = false;
    console.error(`[companion] recovery prompt failed: ${status.lastResumePromptError}`);
  }
}

export function markVoiceIntentionalStop(ttlMs = 20_000) {
  const now = Date.now();
  status.intentionalStopUntil = now + Math.min(Math.max(ttlMs, 5_000), 120_000);
  status.armed = false;
  status.recoveryAttempts = 0;
  status.recoveryPending = false;
  status.recoveryPendingSince = undefined;
  status.recoveryPhrase = undefined;
  return getVoiceRecoveryStatus();
}

export function suspendVoiceRecovery(reason = "manual") {
  status.state = "suspended";
  status.armed = false;
  status.suspendedReason = reason.trim().slice(0, 240) || "manual";
  status.lossStartedAt = undefined;
  return getVoiceRecoveryStatus();
}

export function resumeVoiceRecovery() {
  status.state = "idle";
  status.armed = false;
  status.suspendedReason = undefined;
  status.recoveryAttempts = 0;
  status.cooldownUntil = undefined;
  status.lossStartedAt = undefined;
  return getVoiceRecoveryStatus();
}

export function consumeRecoveryPending() {
  const pending = status.recoveryPending;
  const since = status.recoveryPendingSince;
  status.recoveryPending = false;
  const phrase = status.recoveryPhrase || DEFAULT_RECOVERY_PHRASE;
  status.recoveryPendingSince = undefined;
  status.recoveryPhrase = undefined;
  return { pending, since, phrase };
}
export function startVoiceRecoveryWatchdog() {
  if (timerStarted) return;
  timerStarted = true;

  if (!enabled()) {
    status = { ...status, enabled: false, state: "disabled", armed: false };
    console.log("[companion] ChatGPT voice recovery disabled.");
    return;
  }

  status = { ...status, enabled: true, state: "idle", recoveryAttempts: 0, recoveryPending: false };
  const pollMs = envMs("CLAWMOBILE_VOICE_RECOVERY_POLL_MS", DEFAULT_POLL_MS, 500);
  setTimeout(() => void tick(), 500).unref();
  setInterval(() => void tick(), pollMs).unref();
  console.log(`[companion] ChatGPT voice recovery enabled every ${pollMs}ms.`);
}

async function tick() {
  if (busy || !status.enabled) return;
  busy = true;
  try {
    await observeAndRecover();
  } catch (error: any) {
    status.lastError = error?.message || String(error);
    console.error(`[companion] voice recovery error: ${status.lastError}`);
  } finally {
    busy = false;
  }
}
async function observeAndRecover() {
  if (status.state === "suspended") return;
  const now = Date.now();
  const probe = await probeChatGptVoiceActive();
  status.lastObservedAt = now;
  status.voiceActive = probe.voiceActive;
  if (!probe.ok) {
    status.lastError = probe.detail || "Unable to read ChatGPT RECORD_AUDIO state.";
    return;
  }

  if (probe.voiceActive) {
    status.lastActiveAt = now;
    status.lossStartedAt = undefined;
    if (status.state === "verifying" || status.state === "recovering") {
      status.lastRecoverySucceededAt = now;
      status.recoveryPending = true;
      status.recoveryPendingSince = now;
      status.recoveryPhrase = (process.env.CLAWMOBILE_VOICE_RECOVERY_PHRASE || DEFAULT_RECOVERY_PHRASE).trim();
      status.recoveryAttempts = 0;
      status.cooldownUntil = now + envMs(
        "CLAWMOBILE_VOICE_RECOVERY_COOLDOWN_MS",
        DEFAULT_RECOVERY_COOLDOWN_MS,
        5_000,
      );
    }
    status.state = "active";
    status.lastError = undefined;
    if (status.recoveryPending) void deliverRecoveryPromptOnce();
    status.armed = !status.cooldownUntil || now >= status.cooldownUntil;
    return;
  }

  if (status.intentionalStopUntil && now <= status.intentionalStopUntil) {
    status.state = "idle";
    status.armed = false;
    status.lossStartedAt = undefined;
    return;
  }
  if (status.intentionalStopUntil && now > status.intentionalStopUntil) {
    status.intentionalStopUntil = undefined;
  }
  if (status.state === "verifying") {
    const verifyTimeoutMs = envMs(
      "CLAWMOBILE_VOICE_RECOVERY_VERIFY_TIMEOUT_MS",
      DEFAULT_VERIFY_TIMEOUT_MS,
      3_000,
    );
    if (
      status.lastRecoveryAttemptAt &&
      now - status.lastRecoveryAttemptAt >= verifyTimeoutMs
    ) {
      status.state = "cooldown";
      status.armed = false;
      status.cooldownUntil = now + envMs(
        "CLAWMOBILE_VOICE_RECOVERY_COOLDOWN_MS",
        DEFAULT_RECOVERY_COOLDOWN_MS,
        5_000,
      );
      status.lastError = "Voice did not become active before the verification timeout.";
      const maxAttempts = envInt(
        "CLAWMOBILE_VOICE_RECOVERY_MAX_ATTEMPTS",
        DEFAULT_MAX_RECOVERY_ATTEMPTS,
        1,
        5,
      );
      if (status.recoveryAttempts >= maxAttempts) {
        status.state = "suspended";
        status.cooldownUntil = undefined;
        status.suspendedReason = "Voice recovery failed after " + status.recoveryAttempts + " attempt(s).";
        console.warn("[companion] voice recovery suspended: " + status.suspendedReason);
      }
    }
    return;
  }

  if (status.cooldownUntil && now < status.cooldownUntil) {
    status.state = "cooldown";
    return;
  }
  if (status.cooldownUntil && now >= status.cooldownUntil) {
    status.cooldownUntil = undefined;
    status.state = "idle";
  }

  if (!status.armed) return;

  if (!status.lossStartedAt) {
    status.lossStartedAt = now;
    status.state = "loss_suspected";
    return;
  }
  const debounceMs = envMs(
    "CLAWMOBILE_VOICE_RECOVERY_LOSS_DEBOUNCE_MS",
    DEFAULT_LOSS_DEBOUNCE_MS,
    1_000,
  );
  if (now - status.lossStartedAt < debounceMs) return;

  const maxAttempts = envInt(
    "CLAWMOBILE_VOICE_RECOVERY_MAX_ATTEMPTS",
    DEFAULT_MAX_RECOVERY_ATTEMPTS,
    1,
    5,
  );
  if (status.recoveryAttempts >= maxAttempts) {
    status.state = "suspended";
    status.armed = false;
    status.suspendedReason = "Recovery attempt limit reached (" + maxAttempts + ").";
    status.lastError = status.suspendedReason;
    console.warn("[companion] voice recovery suspended: " + status.suspendedReason);
    return;
  }

  status.state = "recovering";
  status.armed = false;
  status.recoveryAttempts += 1;
  status.lastRecoveryAttemptAt = now;
  const saved = readChatContinuity();
  const deepLink = (process.env.CLAWMOBILE_VOICE_RECOVERY_DEEP_LINK || (saved?.mode === "voice" ? chatConversationUrl(saved.conversationId) : DEFAULT_DEEP_LINK)).trim();
  const launch = await adb_open_uri({ uri: deepLink, package: CHATGPT_PACKAGE, waitMs: 0 });
  if (!launch.ok) {
    status.state = "cooldown";
    status.lastError = launch.stderr || launch.stdout || "Unable to open ChatGPT voice deep-link.";
    status.cooldownUntil = Date.now() + envMs(
      "CLAWMOBILE_VOICE_RECOVERY_COOLDOWN_MS",
      DEFAULT_RECOVERY_COOLDOWN_MS,
      5_000,
    );
    console.error(`[companion] voice recovery launch failed: ${status.lastError}`);
    return;
  }

  status.state = "verifying";
  status.lossStartedAt = undefined;
  console.warn(`[companion] voice loss detected; opened ${deepLink} for recovery.`);
}
