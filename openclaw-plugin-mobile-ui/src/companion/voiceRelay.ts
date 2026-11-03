import crypto from "crypto";
import {TURN_BUDGET_MS, remainingTurnBudgetMs} from "./turnBudget";
import {gatewayTerminalResult} from "./runs";
import {compactOwnerAgentContext} from "./clawLive";
import fs from "fs";
import os from "os";
import path from "path";
import { handleMcpRelayRequest } from "./mcpBridge";
import { registerAuthenticatedMcpRelayMessage } from "./remoteBridge";
import { reconnectDelay } from "./reconnectPolicy";
export { reconnectDelay } from "./reconnectPolicy";
import {
  callOpenClawGateway,
  assertCanonicalAgentPayload,
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

/** Transport binding of a relay conversation to its brain session (ADR 02/11, step 3: every turn goes to the brain). */
type PendingConversation = {
  kind: "agent";
  originalRequest: string;
  agentSessionId?: string;
  brain: true;
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
const CONVERSATION_TTL_MS = 30 * 60_000;
const MAX_BRAIN_CONVERSATIONS = 256;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
// A socket that is not authenticated within this delay is abandoned: after a network
// switch a dead TCP connection can stay CONNECTING or CLOSING without ever emitting close.
const CONNECT_DEADLINE_MS = Number(process.env.CLAW_VOICE_RELAY_CONNECT_DEADLINE_MS || 20_000);

let config: RelayConfig | null = null;
let socket: any = null;
let state: RelayState = "disabled";
let authenticated = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let connectTimer: NodeJS.Timeout | null = null;
let attempts = 0;
let lastConnectedAt = 0;
let lastPongAt = 0;
let lastError = "";

const recent = new Map<string, { hash: string; at: number; response: any }>();
const VOICE_SURFACE = "bixby_claw";
// The relay keeps only its transport binding (conversationId -> brain session), never a question nor a decision.
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

function requestHash(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
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

/** One turn of Samantha's main brain for the relay (no other agent, no resolver before it). */
async function runAgentTurn(
  sessionId: string,
  requestId: string,
  message: string,
) {
  const startedAt = performance.now();
  const sessionKey = expectedCompanionSessionKey(sessionId, "main");
  const canonical=compactOwnerAgentContext({authority:"owner"});
  const params = {
      sessionKey,
      agentId: "main",
      label: "Bixby Voice",
      message,
      deliver: false,
      bootstrapContextMode: "lightweight",
      ...(canonical?{extraSystemPrompt:canonical}:{}),
      idempotencyKey: requestId,
  };
  assertCanonicalAgentPayload(params);
  const budget = remainingTurnBudgetMs(startedAt, performance.now());
  if (!budget) throw new Error("voice_brain_budget_exhausted");
  const raw = await callOpenClawGateway(
    "agent", params,
    { expectFinal: true, timeoutMs: budget, hardTimeoutMs: budget },
  );
  // A late/empty/failed receipt does not prove absence of an effect. Never retry here.
  if (performance.now() - startedAt >= TURN_BUDGET_MS) throw new Error("voice_brain_budget_exhausted");
  if (raw?.success === false || ["error", "failed", "aborted", "timeout", "unknown"].includes(String(raw?.state || raw?.status || ""))) {
    throw new Error("voice_brain_gateway_unverified");
  }
  // Reuse the canonical installed-SDK terminal renderer: summary=completed is not an answer.
  const terminal = typeof raw?.runId === "string" && raw.runId
    ? gatewayTerminalResult(raw, raw.runId) : null;
  if (!terminal || terminal.state !== "done") throw new Error("voice_brain_empty_receipt");
  // Output projection only: the main brain already chose and spoke the question.
  // Reuse the capsule's existing clarification protocol; never classify the input here.
  const explicit = explicitClarificationQuestion(raw);
  return explicit ? {state: "needs_clarification" as const, question: explicit}
    : classifyAgentTurn({text: terminal.text});
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

/** Existing authenticated relay channel only: no native P1 ticket is minted from its bearer.
 * The Gateway and typed tool guards retain their own least-privilege admission checks. */
async function runRelayBrainTurn(requestId: string, message: string, conversationId: string, pending: PendingConversation) {
  cleanupConversations();
  if (!conversations.has(conversationId) && conversations.size >= MAX_BRAIN_CONVERSATIONS)
    return {success: false, state: "failed", source: "samantha_brain", error: "voice_conversation_capacity", retrySafe: false};
  const sessionId = pending.agentSessionId || "voice-" + conversationId;
  // Reuse the existing transport binding before awaiting, so an uncertain receipt keeps continuity.
  conversations.set(conversationId, {...pending, kind: "agent", brain: true, agentSessionId: sessionId, at: Date.now()});
  try {
    const turn = await runAgentTurn(sessionId, requestId, message);
    if (turn.state === "needs_clarification") return clarificationResponse(conversationId, "samantha_brain", turn.question);
    return {success: true, state: "done", source: "samantha_brain", conversationId, text: turn.text};
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "";
    // Only machine-readable refusal codes from the existing official Gateway client are projected.
    const gateway = error as {name?: unknown; gatewayCode?: unknown; details?: {code?: unknown}} | undefined;
    const code = gateway?.name === "GatewayClientRequestError" && gateway?.details?.code === "MISSING_SCOPE"
      ? "missing_scope" : reason;
    const authority = /^(?:voice_owner_admission_required|owner_admission_required|missing_scope|insufficient_scope|unauthorized|forbidden)$/.test(code);
    return {success: false, state: authority ? "failed" : "unknown", source: "samantha_brain", conversationId,
      error: authority ? code : reason.startsWith("voice_brain_") ? reason : "voice_brain_gateway_unverified",
      retrySafe: false};
  }
}

async function runVoiceRequest(requestId: string, request: string) {
  const conversationId = "brain-" + requestHash({channel: VOICE_SURFACE, requestId});
  return runRelayBrainTurn(requestId, request, conversationId, {kind: "agent", brain: true, originalRequest: request, at: Date.now()});
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
  return runRelayBrainTurn(requestId, answer, conversationId, pending);
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
      abandonSocket(socket, "heartbeat_timeout");
      return;
    }
    try {
      socket.send("ping");
    } catch {}
  }, config.heartbeatMs);
  heartbeatTimer.unref?.();
}

function clearConnectTimer() {
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = null;
}

/**
 * Drops the current socket and reconnects without waiting for its close event, which
 * a half-open connection may never emit. Events from an abandoned socket are ignored.
 */
function abandonSocket(ws: any, reason: string) {
  if (!ws || socket !== ws) return;
  lastError = reason;
  stopHeartbeat();
  clearConnectTimer();
  authenticated = false;
  socket = null;
  try {
    ws.close();
  } catch {}
  if (config) scheduleReconnect();
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

async function handleMcpMessage(message: any) {
  const requestId = String(message?.requestId || "").slice(0, 128);
  let response: any;
  try {
    response = await handleMcpRelayRequest(message);
  } catch (error: any) {
    response = {
      state: "failed",
      error: String(error?.message || error || "mcp_bridge_failed").slice(0, 500),
    };
  }
  socket?.send(JSON.stringify({ type: "response", requestId, response }));
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
  clearConnectTimer();
  connectTimer = setTimeout(() => abandonSocket(ws, "connect_timeout"), CONNECT_DEADLINE_MS);
  connectTimer.unref?.();

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
    if (socket !== ws) return;
    try {
      const raw =
        typeof event.data === "string" ? event.data : await event.data.text();

      if (raw === "pong") {
        lastPongAt = Date.now();
        return;
      }

      const message = JSON.parse(raw);
      if (message.type === "auth_ok") {
        clearConnectTimer();
        authenticated = true;
        state = "connected";
        attempts = 0;
        lastConnectedAt = Date.now();
        lastPongAt = Date.now();
        startHeartbeat();
        return;
      }

      if (message.type === "mcp_request" && authenticated) {
        registerAuthenticatedMcpRelayMessage(message);
        void handleMcpMessage(message);
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
    abandonSocket(ws, "voice_relay_websocket_error");
  });

  ws.addEventListener("close", () => {
    abandonSocket(ws, lastError || "voice_relay_closed");
  });
}

/** Test seam: relay voice turns without a relay socket. */
export const voiceRelayTurnsForTest = {
  request: (requestId: string, request: string) => runVoiceRequest(requestId, request),
  continuation: (requestId: string, conversationId: string, answer: string) => runVoiceContinuation(requestId, conversationId, answer),
};

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
  clearConnectTimer();
  try {
    socket?.close();
  } catch {}
  socket = null;
  authenticated = false;
  conversations.clear();
  state = "disabled";
}

/** Test seam: one relay turn without a socket (initial request, or continuation with conversationId + answer). */
export async function voiceRelayTurnForTest(requestId: string, request: string, conversationId = "", answer = "") {
  return conversationId ? runVoiceContinuation(requestId, conversationId, answer) : runVoiceRequest(requestId, request);
}
