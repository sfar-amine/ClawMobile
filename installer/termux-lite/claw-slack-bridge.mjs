#!/data/data/com.termux/files/home/.openclaw-android/bin/node
import fs from "fs";
import os from "os";
import path from "path";

const CONFIG_PATH = process.env.CLAW_SLACK_CONFIG || path.join(os.homedir(), ".openclaw", "remote-bridge", "slack", "config.json");
const SECRET_DIR = path.join(os.homedir(), ".openclaw", "remote-bridge", "slack", "secrets");
const FILE_CONFIG = readConfig(CONFIG_PATH);
const APP_TOKEN = process.env.CLAW_SLACK_APP_TOKEN || readSecret(process.env.CLAW_SLACK_APP_TOKEN_FILE || FILE_CONFIG.appTokenFile || path.join(SECRET_DIR, "app-token"));
const BOT_TOKEN = process.env.CLAW_SLACK_BOT_TOKEN || readSecret(process.env.CLAW_SLACK_BOT_TOKEN_FILE || FILE_CONFIG.botTokenFile || path.join(SECRET_DIR, "bot-token"));
const CHANNEL_ID = process.env.CLAW_SLACK_CHANNEL_ID || String(FILE_CONFIG.channelId || "");
const ALLOWED_USERS = new Set(
  String(process.env.CLAW_SLACK_ALLOWED_USER_IDS || (FILE_CONFIG.allowedUserIds || []).join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const MODE = (process.env.CLAW_SLACK_MODE || FILE_CONFIG.mode) === "active" ? "active" : "shadow";
const BRIDGE_URL = (
  process.env.CLAW_SLACK_BRIDGE_URL ||
  "http://127.0.0.1:8765/v1/extensions/remote-bridge"
).replace(/\/$/, "");
const STATE_DIR = process.env.CLAW_SLACK_STATE_DIR ||
  path.join(os.homedir(), ".openclaw", "remote-bridge", "slack");
const HEALTH_FILE = path.join(STATE_DIR, "health.json");
const EVENT_LOG = path.join(STATE_DIR, "events.log");
const MAX_REPLY_CHARS = 26000;
const SLACK_API_BASE = (process.env.CLAW_SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");
const READ_ONLY = new Set(["ping", "request_status", "task_status", "read_file", "read_binary_file", "artifact_read", "process_status"]);
const HEALTH_HEARTBEAT_MS = Number(process.env.CLAW_SLACK_HEALTH_HEARTBEAT_MS || 15000);

let socket = null;
let stopping = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let botUserId = "";
let sendChain = Promise.resolve();
let healthState = "starting";
let lastTransitionAt = Date.now();

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

function readConfig(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function readSecret(filePath) {
  if (!filePath) return "";
  try {
    const resolved = String(filePath).replace(/^~(?=\/|$)/, os.homedir());
    return fs.readFileSync(resolved, "utf8").trim();
  } catch {
    return "";
  }
}

function sanitizeAuditText(value) {
  return String(value ?? "")
    .replace(/((?:authorization|bearer|token|password|passwd|secret|api[_-]?key|cookie|credential)\s*[:=]\s*)[^\s,;}]+/gi, "$1<redacted>")
    .replace(/\b(otp|2fa|verification\s*code|security\s*code)\b\s*[:=\-]?\s*\d{4,8}\b/gi, "$1 <redacted>")
    .replace(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, "<redacted>");
}

function requestSummary(request) {
  const method = String(request?.method || "");
  const params = request?.params && typeof request.params === "object" ? request.params : {};
  if (method === "exec_wait" || method === "process_start") {
    return { command: sanitizeAuditText(params.command).slice(0, 1200), cwd: String(params.cwd || "").slice(0, 300) };
  }
  if (method === "read_file" || method === "read_binary_file" || method === "write_file" || method === "write_binary_file" || method === "patch_file") {
    return { path: String(params.path || "").slice(0, 600), mode: String(params.mode || "") };
  }
  if (method.startsWith("process_")) {
    return { processId: String(params.processId || "").slice(0, 200) };
  }
  if (method === "artifact_read") {
    return { artifactId: String(params.artifactId || "").slice(0, 200) };
  }
  return {};
}

function auditEvent(event, request, extra = {}) {
  try {
    const value = {
      ts: Date.now(),
      event,
      transport: "slack",
      requestId: String(request?.requestId || "unknown"),
      taskId: String(request?.taskId || ""),
      sessionId: String(request?.sessionId || ""),
      method: String(request?.method || ""),
      summary: requestSummary(request),
      ...extra,
    };
    fs.appendFileSync(EVENT_LOG, JSON.stringify(value) + "\n", { mode: 0o600 });
  } catch {}
}

function writeHealth(state, extra = {}) {
  const now = Date.now();
  if (state !== healthState) {
    healthState = state;
    lastTransitionAt = now;
  }
  const value = {
    state: healthState,
    mode: MODE,
    channelId: CHANNEL_ID,
    connected: socket?.readyState === WebSocket.OPEN,
    updatedAt: now,
    heartbeatAt: now,
    lastTransitionAt,
    runtimeRoot: path.dirname(path.resolve(process.argv[1] || ".")),
    pid: process.pid,
    ...extra,
  };
  const temp = `${HEALTH_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, HEALTH_FILE);
}

async function slackApi(method, token, body = {}) {
  const response = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok || !value.ok) {
    const error = new Error(`slack_api_${method}:${value.error || response.status}`);
    error.retryAfter = Number(response.headers.get("retry-after") || 0);
    throw error;
  }
  return value;
}

async function bridgeCall(payload) {
  const response = await fetch(`${BRIDGE_URL}/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const value = await response.json();
  if (!response.ok && response.status !== 400) {
    throw new Error(`bridge_http_${response.status}`);
  }
  return value;
}

function parseRpc(text) {
  const original = String(text || "").trim();
  const raw = original.startsWith("CLAW_RPC_V1_B64")
    ? original
    : original.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  let jsonText = "";
  if (raw.startsWith("CLAW_RPC_V1_B64")) {
    const encodedRaw = raw.slice("CLAW_RPC_V1_B64".length).trim();
    const token = encodedRaw.match(/^([A-Za-z0-9_-]{1,60000})/);
    const encoded = token?.[1] || "";
    if (!encoded) throw new Error("rpc_b64_invalid");
    jsonText = Buffer.from(encoded, "base64url").toString("utf8");
    if (!jsonText.trim().startsWith("{")) throw new Error("rpc_b64_invalid");
  } else if (raw.startsWith("CLAW_RPC_V1")) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("rpc_json_missing");
    jsonText = raw.slice(start, end + 1);
  } else {
    return null;
  }
  const payload = JSON.parse(jsonText);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("rpc_invalid");
  return payload;
}

function compactReply(receipt) {
  const payload = JSON.stringify(receipt);
  const requestId = receipt?.requestId || "unknown";
  const state = receipt?.state || "unknown";
  const prefix = `CLAW_RPC_RESULT_V1 request=${requestId} state=${state}\n`;
  if (prefix.length + payload.length <= MAX_REPLY_CHARS) {
    return prefix + "```json\n" + payload + "\n```";
  }
  const result = receipt?.result || {};
  const artifact = result?.artifact;
  const summary = {
    requestId,
    state,
    mutationRisk: receipt?.mutationRisk,
    error: receipt?.error,
    artifact,
    preview: String(result?.preview || "").slice(0, 8000),
  };
  return prefix + "```json\n" + JSON.stringify(summary) + "\n```";
}

function queueReply(channel, threadTs, text) {
  sendChain = sendChain.then(async () => {
    for (;;) {
      try {
        await slackApi("chat.postMessage", BOT_TOKEN, {
          channel,
          thread_ts: threadTs,
          text,
          unfurl_links: false,
          unfurl_media: false,
        });
        return;
      } catch (error) {
        const wait = Number(error.retryAfter || 0);
        if (!wait) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.max(1000, wait * 1000)));
      }
    }
  }).catch((error) => {
    writeHealth("degraded", { lastError: error.message });
  });
}

async function handleEvent(event) {
  if (!event || event.type !== "message") return;
  if (event.subtype || event.bot_id) return;
  if (event.user === botUserId) return;
  if (event.channel !== CHANNEL_ID) return;
  if (!ALLOWED_USERS.has(String(event.user || ""))) return;

  let request;
  try {
    request = parseRpc(event.text);
  } catch (error) {
    const original = String(event.text || "").trim();
    const plain = original.startsWith("CLAW_RPC_V1") && !original.startsWith("CLAW_RPC_V1_B64");
    const action = plain ? " action=use_b64" : "";
    queueReply(
      event.channel,
      event.thread_ts || event.ts,
      `CLAW_RPC_ERROR_V1 code=${sanitizeAuditText(error.message)}${action}`,
    );
    return;
  }
  if (!request) return;
  auditEvent("request", request, { mode: MODE });
  if (MODE !== "active" && !READ_ONLY.has(String(request.method || ""))) {
    auditEvent("rejected", request, { state: "rejected_shadow" });
    queueReply(
      event.channel,
      event.thread_ts || event.ts,
      `CLAW_RPC_RESULT_V1 request=${request.requestId || "unknown"} state=rejected_shadow\nMethod not allowed while Slack bridge is in shadow mode.`,
    );
    return;
  }

  try {
    const receipt = await bridgeCall(request);
    auditEvent("result", request, {
      state: String(receipt?.state || "unknown"),
      mutationRisk: String(receipt?.mutationRisk || ""),
    });
    queueReply(event.channel, event.thread_ts || event.ts, compactReply(receipt));
  } catch (error) {
    auditEvent("error", request, { state: "transport_error", error: sanitizeAuditText(error.message).slice(0, 500) });
    queueReply(
      event.channel,
      event.thread_ts || event.ts,
      `CLAW_RPC_RESULT_V1 request=${request.requestId || "unknown"} state=transport_error\n${error.message}`,
    );
    writeHealth("degraded", { lastError: error.message });
  }
}

async function connect() {
  if (stopping) return;
  if (!APP_TOKEN || !BOT_TOKEN || !CHANNEL_ID || ALLOWED_USERS.size === 0) {
    writeHealth("setup_required", {
      lastError: "CLAW_SLACK_APP_TOKEN, CLAW_SLACK_BOT_TOKEN, CLAW_SLACK_CHANNEL_ID and CLAW_SLACK_ALLOWED_USER_IDS are required.",
    });
    process.exitCode = 78;
    return;
  }

  try {
    const auth = await slackApi("auth.test", BOT_TOKEN);
    botUserId = String(auth.user_id || "");
    const opened = await slackApi("apps.connections.open", APP_TOKEN);
    const currentSocket = new WebSocket(opened.url);
    socket = currentSocket;
    currentSocket.addEventListener("open", () => {
      if (socket !== currentSocket) return;
      reconnectAttempt = 0;
      writeHealth("healthy", { botUserId });
    });
    currentSocket.addEventListener("message", (message) => {
      if (socket !== currentSocket) return;
      void handleSocketMessage(String(message.data || ""));
    });
    currentSocket.addEventListener("close", () => {
      if (socket === currentSocket) scheduleReconnect("socket_closed");
    });
    currentSocket.addEventListener("error", () => {
      if (socket === currentSocket) scheduleReconnect("socket_error");
    });
  } catch (error) {
    writeHealth("degraded", { lastError: error.message });
    scheduleReconnect(error.message);
  }
}

async function handleSocketMessage(raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return;
  }
  if (envelope.envelope_id && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
  }
  if (envelope.type === "disconnect") {
    scheduleReconnect("slack_disconnect");
    return;
  }
  if (envelope.type === "events_api") {
    await handleEvent(envelope.payload?.event);
  }
}

function scheduleReconnect(reason) {
  if (stopping || reconnectTimer) return;
  const previousSocket = socket;
  socket = null;
  try { previousSocket?.close(); } catch {}
  reconnectAttempt += 1;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(5, reconnectAttempt - 1));
  writeHealth("reconnecting", { reason, reconnectAttempt, retryInMs: delay });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function shutdown() {
  stopping = true;
  writeHealth("stopping");
  try { socket?.close(); } catch {}
  setTimeout(() => process.exit(0), 200).unref();
}

const healthHeartbeat = setInterval(() => {
  if (!stopping) writeHealth(healthState, botUserId ? { botUserId } : {});
}, Math.max(5000, HEALTH_HEARTBEAT_MS));
healthHeartbeat.unref();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
writeHealth("starting");
void connect();
