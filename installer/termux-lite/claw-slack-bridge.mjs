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
const MAX_REPLY_CHARS = 26000;
const SLACK_API_BASE = (process.env.CLAW_SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");
const READ_ONLY = new Set(["ping", "request_status", "read_file", "artifact_read", "process_status"]);

let socket = null;
let stopping = false;
let reconnectAttempt = 0;
let botUserId = "";
let sendChain = Promise.resolve();

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

function writeHealth(state, extra = {}) {
  const value = {
    state,
    mode: MODE,
    channelId: CHANNEL_ID,
    connected: socket?.readyState === WebSocket.OPEN,
    updatedAt: Date.now(),
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
  const raw = String(text || "").trim();
  if (!raw.startsWith("CLAW_RPC_V1")) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("rpc_json_missing");
  const payload = JSON.parse(raw.slice(start, end + 1));
  if (!payload || typeof payload !== "object") throw new Error("rpc_invalid");
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
    queueReply(event.channel, event.thread_ts || event.ts, `CLAW_RPC_ERROR_V1 ${error.message}`);
    return;
  }
  if (!request) return;
  if (MODE !== "active" && !READ_ONLY.has(String(request.method || ""))) {
    queueReply(
      event.channel,
      event.thread_ts || event.ts,
      `CLAW_RPC_RESULT_V1 request=${request.requestId || "unknown"} state=rejected_shadow\nMethod not allowed while Slack bridge is in shadow mode.`,
    );
    return;
  }

  try {
    const receipt = await bridgeCall(request);
    queueReply(event.channel, event.thread_ts || event.ts, compactReply(receipt));
  } catch (error) {
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
    socket = new WebSocket(opened.url);
    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      writeHealth("healthy", { botUserId });
    });
    socket.addEventListener("message", (message) => {
      void handleSocketMessage(String(message.data || ""));
    });
    socket.addEventListener("close", () => scheduleReconnect("socket_closed"));
    socket.addEventListener("error", () => writeHealth("degraded", { lastError: "socket_error" }));
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
    try { socket?.close(); } catch {}
    return;
  }
  if (envelope.type === "events_api") {
    await handleEvent(envelope.payload?.event);
  }
}

function scheduleReconnect(reason) {
  if (stopping) return;
  try { socket?.close(); } catch {}
  socket = null;
  reconnectAttempt += 1;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(5, reconnectAttempt - 1));
  writeHealth("reconnecting", { reason, reconnectAttempt, retryInMs: delay });
  setTimeout(() => void connect(), delay).unref();
}

function shutdown() {
  stopping = true;
  writeHealth("stopping");
  try { socket?.close(); } catch {}
  setTimeout(() => process.exit(0), 200).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
writeHealth("starting");
void connect();
