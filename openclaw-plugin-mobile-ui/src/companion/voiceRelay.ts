import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { capabilityBridge } from "./capabilityBridge";
import { callOpenClawGateway, expectedCompanionSessionKey } from "./openclawAgentClient";

type RelayConfig = {
  url: string;
  tokenFile: string;
  heartbeatMs: number;
};

type RelayState = "disabled" | "connecting" | "authenticating" | "connected" | "reconnecting" | "unavailable";

const CONFIG_PATH = process.env.CLAW_VOICE_RELAY_CONFIG ||
  path.join(os.homedir(), ".openclaw", "voice-relay", "config.json");
const MAX_REQUEST_CHARS = 12000;
const RECENT_TTL_MS = 10 * 60_000;

let config: RelayConfig | null = null;
let socket: any = null;
let state: RelayState = "disabled";
let authenticated = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let attempts = 0;
let lastConnectedAt = 0;
let lastPongAt = 0;
let lastError = "";
const recent = new Map<string, { hash: string; at: number; response: any }>();
function expandHome(value: string) {
  return value.replace(/^~(?=\/|$)/, os.homedir());
}

function readConfig(): RelayConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const url = String(raw?.url || "").trim();
  if (!/^wss:\/\//.test(url)) throw new Error("voice_relay_url_must_be_wss");
  const tokenFile = expandHome(String(raw?.tokenFile ||
    path.join(os.homedir(), ".openclaw", "credentials", "voice-relay-device.token")));
  if (!fs.existsSync(tokenFile)) throw new Error("voice_relay_token_missing");
  const heartbeatSeconds = Math.max(20, Math.min(180, Number(raw?.heartbeatSeconds || 45)));
  return { url, tokenFile, heartbeatMs: Math.round(heartbeatSeconds * 1000) };
}

function deviceToken(cfg: RelayConfig) {
  const value = fs.readFileSync(cfg.tokenFile, "utf8").trim();
  if (value.length < 24) throw new Error("voice_relay_token_invalid");
  return value;
}

export function reconnectDelay(attempt: number) {
  if (attempt <= 0) return 0;
  if (attempt === 1) return 750;
  if (attempt === 2) return 2000;
  return Math.min(60_000, 3000 * (2 ** Math.min(5, attempt - 3)));
}

function requestHash(request: string) {
  return crypto.createHash("sha256").update(request).digest("hex");
}
export function voiceRelayHealth() {
  return {
    state,
    configured: Boolean(config),
    connected: state === "connected" && authenticated,
    authenticated,
    attempts,
    lastConnectedAt: lastConnectedAt || null,
    lastPongAt: lastPongAt || null,
    lastError: lastError || null,
    heartbeatSeconds: config ? Math.round(config.heartbeatMs / 1000) : null,
  };
}

function cleanupRecent(now = Date.now()) {
  for (const [key, value] of recent) {
    if (now - value.at > RECENT_TTL_MS) recent.delete(key);
  }
}

export function renderFastVoiceResult(value: any): string | null {
  const execution = value?.execution;
  const result = execution?.result;
  if (!execution || execution.state !== "completed" || !result || typeof result !== "object") return null;
  if (result.state === "needs_counter" && result.sent === false && Array.isArray(result.choices)) {
    const labels: Record<string, string> = {
      recharge: "solde de recharge",
      balances: "tous les soldes",
      principal: "solde principal",
    };
    return "Précise : " + result.choices.map((x: any) => labels[String(x)] || String(x)).join(" ou ") + ".";
  }
  if (result.ok !== true) return null;
  for (const key of ["text", "message", "summary"]) {
    if (typeof result[key] === "string" && result[key].trim()) return result[key].trim();
  }
  const data = result.data;
  if (!data || typeof data !== "object") return null;
  const labels: Record<string, string> = {
    recharge: "solde de recharge",
    data: "data restante",
    voice: "voix restante",
    phone_number: "numéro",
    offer: "offre",
  };
  const parts: string[] = [];
  for (const [key, item] of Object.entries(data as Record<string, any>)) {
    if (!item || typeof item !== "object") continue;
    if (item.value !== undefined) {
      const unit = item.unit ? " " + String(item.unit) : "";
      parts.push((labels[key] || key) + " : " + String(item.value) + unit);
    }
  }
  return parts.length ? parts.slice(0, 4).join(", ") + "." : null;
}

function extractAgentText(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  for (const key of ["result", "message", "text", "output", "summary"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return extractAgentText(value.final) || extractAgentText(value.response);
}
async function runVoiceRequest(requestId: string, request: string) {
  const resolved: any = await capabilityBridge(request, {
    execute: false,
    surface: "bixby_claw",
    caller: "owner",
    timeoutSeconds: 20,
  });
  const selected = resolved?.selected;
  if (resolved?.success !== false && selected?.deterministic === true &&
      selected?.risk === "read" && resolved?.confirmation_required !== true) {
    const executed: any = await capabilityBridge(request, {
      execute: true,
      surface: "bixby_claw",
      caller: "owner",
      timeoutSeconds: 30,
    });
    const text = renderFastVoiceResult(executed);
    if (text) {
      return {
        success: true,
        source: "deterministic",
        text,
        capability: executed?.capability || null,
        route: executed?.selected?.route || executed?.execution?.route || null,
      };
    }
  }
  const sessionKey = expectedCompanionSessionKey("bixby-voice");
  const raw = await callOpenClawGateway("agent", {
    sessionKey,
    label: "Bixby Voice",
    message: request,
    deliver: false,
    bootstrapContextMode: "lightweight",
    idempotencyKey: requestId,
  }, { expectFinal: true, timeoutMs: 28_000 });
  const text = extractAgentText(raw);
  return {
    success: Boolean(text),
    source: "agent",
    text: text || "Claw n'a pas retourné de réponse exploitable.",
  };
}

async function handleRequest(message: any) {
  const requestId = String(message?.requestId || "").trim();
  const request = String(message?.request || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ||
      !request || request.length > MAX_REQUEST_CHARS) {
    socket?.send(JSON.stringify({
      type: "response",
      requestId,
      response: { success: false, error: "invalid_request" },
    }));
    return;
  }
  cleanupRecent();
  const hash = requestHash(request);
  const prior = recent.get(requestId);
  if (prior) {
    const response = prior.hash === hash
      ? prior.response
      : { success: false, error: "request_id_conflict" };
    socket?.send(JSON.stringify({ type: "response", requestId, response }));
    return;
  }
  let response: any;
  try {
    response = await runVoiceRequest(requestId, request);
  } catch (error: any) {
    response = {
      success: false,
      error: String(error?.message || error).slice(0, 500),
    };
  }
  recent.set(requestId, { hash, at: Date.now(), response });
  socket?.send(JSON.stringify({ type: "response", requestId, response }));
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat() {
  stopHeartbeat();
  if (!config) return;
  heartbeatTimer = setInterval(() => {
    if (!socket || socket.readyState !== 1 || !authenticated) return;
    if (lastPongAt && Date.now() - lastPongAt > config!.heartbeatMs * 2.5) {
      lastError = "heartbeat_timeout";
      try { socket.close(); } catch {}
      return;
    }
    try { socket.send("ping"); } catch {}
  }, config.heartbeatMs);
  heartbeatTimer.unref?.();
}
function scheduleReconnect() {
  if (!config || reconnectTimer) return;
  state = "reconnecting";
  const delay = reconnectDelay(attempts++);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  reconnectTimer.unref?.();
}

function connect() {
  if (!config) return;
  const WS: any = (globalThis as any).WebSocket;
  if (!WS) {
    state = "unavailable";
    lastError = "websocket_unavailable";
    return;
  }
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
  state = "connecting";
  authenticated = false;
  const ws = new WS(config.url);
  socket = ws;
  ws.addEventListener("open", () => {
    state = "authenticating";
    try {
      ws.send(JSON.stringify({ type: "auth", token: deviceToken(config!) }));
    } catch (error: any) {
      lastError = String(error?.message || error);
      ws.close();
    }
  });
  ws.addEventListener("message", async (event: any) => {
    try {
      const raw = typeof event.data === "string"
        ? event.data
        : await event.data.text();
      if (raw === "pong") {
        lastPongAt = Date.now();
        return;
      }
      const message = JSON.parse(raw);
      if (message.type === "auth_ok") {
        authenticated = true;
        state = "connected";
        attempts = 0;
        lastConnectedAt = Date.now();
        lastPongAt = Date.now();
        startHeartbeat();
        return;
      }
      if (message.type === "request" && authenticated) {
        void handleRequest(message);
      }
    } catch (error: any) {
      lastError = String(error?.message || error).slice(0, 500);
    }
  });
  ws.addEventListener("error", () => {
    lastError = "voice_relay_websocket_error";
  });
  ws.addEventListener("close", () => {
    stopHeartbeat();
    authenticated = false;
    socket = null;
    if (config) scheduleReconnect();
  });
}
export function startVoiceRelay() {
  try {
    config = readConfig();
    if (!config) {
      state = "disabled";
      return voiceRelayHealth();
    }
    connect();
  } catch (error: any) {
    state = "unavailable";
    lastError = String(error?.message || error).slice(0, 500);
  }
  return voiceRelayHealth();
}

export function stopVoiceRelay() {
  config = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopHeartbeat();
  try { socket?.close(); } catch {}
  socket = null;
  authenticated = false;
  state = "disabled";
}
