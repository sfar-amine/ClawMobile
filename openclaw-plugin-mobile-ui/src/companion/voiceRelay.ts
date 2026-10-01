import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { capabilityBridge } from "./capabilityBridge";
import {
  callOpenClawGateway,
  expectedCompanionSessionKey,
} from "./openclawAgentClient";

type RelayConfig = {
  url: string;
  tokenFile: string;
  heartbeatMs: number;
};

type RelayState =
  | "disabled"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "unavailable";

type PendingConversation = {
  kind: "deterministic" | "agent";
  originalRequest: string;
  agentSessionId?: string;
  at: number;
};

type AgentTurn =
  | { state: "done"; text: string }
  | { state: "needs_clarification"; question: string };

const CONFIG_PATH =
  process.env.CLAW_VOICE_RELAY_CONFIG ||
  path.join(os.homedir(), ".openclaw", "voice-relay", "config.json");
const MAX_REQUEST_CHARS = 12000;
const RECENT_TTL_MS = 10 * 60_000;
const CONVERSATION_TTL_MS = 10 * 60_000;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

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
const conversations = new Map<string, PendingConversation>();

function expandHome(value: string) {
  return value.replace(/^~(?=\/|$)/, os.homedir());
}

function readConfig(): RelayConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const url = String(raw?.url || "").trim();
  if (!/^wss:\/\//.test(url)) throw new Error("voice_relay_url_must_be_wss");
  const tokenFile = expandHome(
    String(
      raw?.tokenFile ||
        path.join(
          os.homedir(),
          ".openclaw",
          "credentials",
          "voice-relay-device.token",
        ),
    ),
  );
  if (!fs.existsSync(tokenFile)) throw new Error("voice_relay_token_missing");
  const heartbeatSeconds = Math.max(
    20,
    Math.min(180, Number(raw?.heartbeatSeconds || 45)),
  );
  return {
    url,
    tokenFile,
    heartbeatMs: Math.round(heartbeatSeconds * 1000),
  };
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
  return Math.min(60_000, 3000 * 2 ** Math.min(5, attempt - 3));
}

function requestHash(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function newConversationId() {
  return "conv-" + crypto.randomBytes(12).toString("hex");
}

function cleanupRecent(now = Date.now()) {
  for (const [key, value] of recent) {
    if (now - value.at > RECENT_TTL_MS) recent.delete(key);
  }
}

function cleanupConversations(now = Date.now()) {
  for (const [key, value] of conversations) {
    if (now - value.at > CONVERSATION_TTL_MS) conversations.delete(key);
  }
}

export function voiceRelayHealth() {
  cleanupConversations();
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
    pendingConversations: conversations.size,
  };
}

function labelsForChoices(choices: unknown[]) {
  const labels: Record<string, string> = {
    recharge: "solde de recharge",
    balances: "tous les soldes",
    principal: "solde principal",
  };
  return choices.map((value) => labels[String(value)] || String(value));
}

function questionForChoices(choices: unknown[]) {
  return "Précise : " + labelsForChoices(choices).join(" ou ") + ".";
}

export function extractFastClarification(value: any) {
  const execution = value?.execution;
  const result = execution?.result;
  if (
    !execution ||
    execution.state !== "completed" ||
    !result ||
    typeof result !== "object"
  ) {
    return null;
  }
  if (
    result.state === "needs_counter" &&
    result.sent === false &&
    Array.isArray(result.choices) &&
    result.choices.length
  ) {
    return {
      question: questionForChoices(result.choices),
      choices: result.choices.map((item: any) => String(item)),
    };
  }
  return null;
}

export function renderFastVoiceResult(value: any): string | null {
  const execution = value?.execution;
  const result = execution?.result;
  if (
    !execution ||
    execution.state !== "completed" ||
    !result ||
    typeof result !== "object"
  ) {
    return null;
  }
  if (extractFastClarification(value)) return null;
  if (result.ok !== true) return null;

  for (const key of ["text", "message", "summary"]) {
    if (typeof result[key] === "string" && result[key].trim()) {
      return result[key].trim();
    }
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
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key].trim();
    }
  }
  return extractAgentText(value.final) || extractAgentText(value.response);
}

function explicitClarificationQuestion(value: any, depth = 0): string {
  if (!value || typeof value !== "object" || depth > 5) return "";

  if (
    value.state === "needs_clarification" &&
    typeof value.question === "string" &&
    value.question.trim()
  ) {
    return value.question.trim();
  }

  const execution = value.execution;
  if (
    execution &&
    typeof execution === "object" &&
    execution.state === "needs_clarification"
  ) {
    if (typeof execution.question === "string" && execution.question.trim()) {
      return execution.question.trim();
    }
    if (Array.isArray(execution.choices) && execution.choices.length) {
      return questionForChoices(execution.choices);
    }
  }

  for (const key of ["final", "response", "result"]) {
    const nested = explicitClarificationQuestion(value[key], depth + 1);
    if (nested) return nested;
  }
  return "";
}

export function looksLikeClarificationQuestion(text: string) {
  const value = String(text || "").trim();
  if (!value || value.length > 600 || !/\?\s*$/.test(value)) return false;

  const lead =
    /^(pr[eé]cise|peux-tu pr[eé]ciser|quel|quelle|quels|quelles|quand|o[uù]|combien|lequel|laquelle|lesquels|lesquelles|dois-je|veux-tu|souhaites-tu|est-ce que)\b/i;
  if (lead.test(value)) return true;

  const sentences = value
    .split(/[.!?]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return sentences.length === 1 && value.length <= 240;
}

export function classifyAgentTurn(value: any): AgentTurn {
  const explicit = explicitClarificationQuestion(value);
  if (explicit) {
    return { state: "needs_clarification", question: explicit };
  }

  const text = extractAgentText(value);
  if (looksLikeClarificationQuestion(text)) {
    return { state: "needs_clarification", question: text };
  }
  return { state: "done", text };
}

export function composeContinuationRequest(
  originalRequest: string,
  answer: string,
) {
  const original = String(originalRequest || "").trim();
  const clarification = String(answer || "").trim();
  return (original + "\nPrécision utilisateur : " + clarification).slice(
    0,
    MAX_REQUEST_CHARS,
  );
}

async function resolveDeterministic(request: string) {
  const resolved: any = await capabilityBridge(request, {
    execute: false,
    surface: "bixby_claw",
    caller: "owner",
    timeoutSeconds: 20,
  });
  const selected = resolved?.selected;
  if (
    resolved?.success === false ||
    selected?.deterministic !== true ||
    selected?.risk !== "read" ||
    resolved?.confirmation_required === true
  ) {
    return null;
  }

  const executed: any = await capabilityBridge(request, {
    execute: true,
    surface: "bixby_claw",
    caller: "owner",
    timeoutSeconds: 30,
  });

  const clarification = extractFastClarification(executed);
  if (clarification) {
    return {
      state: "needs_clarification" as const,
      question: clarification.question,
      choices: clarification.choices,
      capability: executed?.capability || null,
      route: executed?.selected?.route || executed?.execution?.route || null,
    };
  }

  const text = renderFastVoiceResult(executed);
  if (!text) return null;
  return {
    state: "done" as const,
    text,
    capability: executed?.capability || null,
    route: executed?.selected?.route || executed?.execution?.route || null,
  };
}

async function runAgentTurn(
  sessionId: string,
  requestId: string,
  message: string,
) {
  const sessionKey = expectedCompanionSessionKey(sessionId);
  const raw = await callOpenClawGateway(
    "agent",
    {
      sessionKey,
      label: "Bixby Voice",
      message,
      deliver: false,
      bootstrapContextMode: "lightweight",
      idempotencyKey: requestId,
    },
    { expectFinal: true, timeoutMs: 20_000 },
  );
  return classifyAgentTurn(raw);
}

function clarificationResponse(
  conversationId: string,
  source: string,
  question: string,
  extra: Record<string, any> = {},
) {
  return {
    success: true,
    state: "needs_clarification",
    source,
    conversationId,
    question,
    text: question,
    ...extra,
  };
}

async function runVoiceRequest(requestId: string, request: string) {
  const deterministic = await resolveDeterministic(request);
  if (deterministic?.state === "needs_clarification") {
    const conversationId = newConversationId();
    conversations.set(conversationId, {
      kind: "deterministic",
      originalRequest: request,
      at: Date.now(),
    });
    return clarificationResponse(
      conversationId,
      "deterministic",
      deterministic.question,
      {
        choices: deterministic.choices,
        capability: deterministic.capability,
        route: deterministic.route,
      },
    );
  }
  if (deterministic?.state === "done") {
    return {
      success: true,
      state: "done",
      source: "deterministic",
      text: deterministic.text,
      capability: deterministic.capability,
      route: deterministic.route,
    };
  }

  const conversationId = newConversationId();
  const agentSessionId = "bixby-voice-" + conversationId;
  const turn = await runAgentTurn(agentSessionId, requestId, request);
  if (turn.state === "needs_clarification") {
    conversations.set(conversationId, {
      kind: "agent",
      originalRequest: request,
      agentSessionId,
      at: Date.now(),
    });
    return clarificationResponse(conversationId, "agent", turn.question);
  }

  return {
    success: Boolean(turn.text),
    state: "done",
    source: "agent",
    text: turn.text || "Claw n'a pas retourné de réponse exploitable.",
  };
}

async function runVoiceContinuation(
  requestId: string,
  conversationId: string,
  answer: string,
) {
  cleanupConversations();
  const pending = conversations.get(conversationId);
  if (!pending) {
    return { success: false, error: "conversation_expired" };
  }

  pending.at = Date.now();

  if (pending.kind === "deterministic") {
    const refined = composeContinuationRequest(pending.originalRequest, answer);
    const deterministic = await resolveDeterministic(refined);
    if (deterministic?.state === "needs_clarification") {
      pending.originalRequest = refined;
      pending.at = Date.now();
      return clarificationResponse(
        conversationId,
        "deterministic",
        deterministic.question,
        {
          choices: deterministic.choices,
          capability: deterministic.capability,
          route: deterministic.route,
        },
      );
    }
    if (deterministic?.state === "done") {
      conversations.delete(conversationId);
      return {
        success: true,
        state: "done",
        source: "deterministic",
        text: deterministic.text,
        capability: deterministic.capability,
        route: deterministic.route,
      };
    }

    const agentSessionId = "bixby-voice-" + conversationId;
    const turn = await runAgentTurn(agentSessionId, requestId, refined);
    if (turn.state === "needs_clarification") {
      conversations.set(conversationId, {
        kind: "agent",
        originalRequest: refined,
        agentSessionId,
        at: Date.now(),
      });
      return clarificationResponse(conversationId, "agent", turn.question);
    }
    conversations.delete(conversationId);
    return {
      success: Boolean(turn.text),
      state: "done",
      source: "agent",
      text: turn.text || "Claw n'a pas retourné de réponse exploitable.",
    };
  }

  const agentSessionId =
    pending.agentSessionId || "bixby-voice-" + conversationId;
  const turn = await runAgentTurn(agentSessionId, requestId, answer);
  if (turn.state === "needs_clarification") {
    pending.agentSessionId = agentSessionId;
    pending.at = Date.now();
    return clarificationResponse(conversationId, "agent", turn.question);
  }

  conversations.delete(conversationId);
  return {
    success: Boolean(turn.text),
    state: "done",
    source: "agent",
    text: turn.text || "Claw n'a pas retourné de réponse exploitable.",
  };
}

async function handleRequest(message: any) {
  const requestId = String(message?.requestId || "").trim();
  const request = String(message?.request || "").trim();
  const conversationId = String(message?.conversationId || "").trim();
  const answer = String(message?.answer || "").trim();
  const isContinuation = Boolean(conversationId || answer);

  const invalidInitial =
    !isContinuation && (!request || request.length > MAX_REQUEST_CHARS);
  const invalidContinuation =
    isContinuation &&
    (!ID_RE.test(conversationId) ||
      !answer ||
      answer.length > MAX_REQUEST_CHARS ||
      Boolean(request));

  if (!ID_RE.test(requestId) || invalidInitial || invalidContinuation) {
    socket?.send(
      JSON.stringify({
        type: "response",
        requestId,
        response: { success: false, error: "invalid_request" },
      }),
    );
    return;
  }

  cleanupRecent();
  cleanupConversations();

  const hash = requestHash({ request, conversationId, answer });
  const prior = recent.get(requestId);
  if (prior) {
    const response =
      prior.hash === hash
        ? prior.response
        : { success: false, error: "request_id_conflict" };
    socket?.send(
      JSON.stringify({ type: "response", requestId, response }),
    );
    return;
  }

  let response: any;
  try {
    response = isContinuation
      ? await runVoiceContinuation(requestId, conversationId, answer)
      : await runVoiceRequest(requestId, request);
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
    if (
      lastPongAt &&
      Date.now() - lastPongAt > config!.heartbeatMs * 2.5
    ) {
      lastError = "heartbeat_timeout";
      try {
        socket.close();
      } catch {}
      return;
    }
    try {
      socket.send("ping");
    } catch {}
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
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
    return;
  }

  state = "connecting";
  authenticated = false;
  const ws = new WS(config.url);
  socket = ws;

  ws.addEventListener("open", () => {
    state = "authenticating";
    try {
      ws.send(
        JSON.stringify({ type: "auth", token: deviceToken(config!) }),
      );
    } catch (error: any) {
      lastError = String(error?.message || error);
      ws.close();
    }
  });

  ws.addEventListener("message", async (event: any) => {
    try {
      const raw =
        typeof event.data === "string" ? event.data : await event.data.text();

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
  try {
    socket?.close();
  } catch {}
  socket = null;
  authenticated = false;
  conversations.clear();
  state = "disabled";
}
