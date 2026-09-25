import { adb_open_uri, adb_shell } from "../backends/adb";

const CHATGPT_PACKAGE = "com.openai.chatgpt";
const DEFAULT_POLL_MS = 1_500;
const DEFAULT_LOSS_DEBOUNCE_MS = 4_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 15_000;
const DEFAULT_RECOVERY_COOLDOWN_MS = 60_000;
const DEFAULT_DEEP_LINK = "https://chatgpt.com/voice";

type VoiceRecoveryState =
  | "disabled"
  | "idle"
  | "active"
  | "loss_suspected"
  | "recovering"
  | "verifying"
  | "cooldown";

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
  lastError?: string;
};

let busy = false;
let timerStarted = false;
let status: VoiceRecoveryStatus = {
  enabled: false,
  state: "disabled",
  voiceActive: false,
  armed: false,
};
function envMs(name: string, fallback: number, minimum: number) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
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

export function markVoiceIntentionalStop(ttlMs = 20_000) {
  const now = Date.now();
  status.intentionalStopUntil = now + Math.min(Math.max(ttlMs, 5_000), 120_000);
  status.armed = false;
  return getVoiceRecoveryStatus();
}
export function startVoiceRecoveryWatchdog() {
  if (timerStarted) return;
  timerStarted = true;

  if (!enabled()) {
    status = { ...status, enabled: false, state: "disabled", armed: false };
    console.log("[companion] ChatGPT voice recovery disabled.");
    return;
  }

  status = { ...status, enabled: true, state: "idle" };
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
      status.cooldownUntil = now + envMs(
        "CLAWMOBILE_VOICE_RECOVERY_COOLDOWN_MS",
        DEFAULT_RECOVERY_COOLDOWN_MS,
        5_000,
      );
    }
    status.state = "active";
    status.lastError = undefined;
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

  status.state = "recovering";
  status.armed = false;
  status.lastRecoveryAttemptAt = now;
  const deepLink = (process.env.CLAWMOBILE_VOICE_RECOVERY_DEEP_LINK || DEFAULT_DEEP_LINK).trim();
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
