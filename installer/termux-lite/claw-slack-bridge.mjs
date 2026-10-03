#!/data/data/com.termux/files/home/.openclaw-android/bin/node
import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "node:crypto";
import { SlackJournal, fetchJson } from "./claw-slack-journal.mjs";

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
const duration = (value, fallback, max) => Number.isFinite(Number(value)) && Number(value) >= 100 && Number(value) <= max ? Number(value) : fallback;
const HTTP_TIMEOUT_MS = duration(process.env.CLAW_SLACK_HTTP_TIMEOUT_MS, 10000, 120000);
const BRIDGE_TIMEOUT_MS = duration(process.env.CLAW_SLACK_BRIDGE_TIMEOUT_MS, 35000, 180000);
const MAX_ATTEMPTS = 6;
const POST_INTERVAL_MS = 1000;
const activeRequests = new Set();
let publishing = false, nextPostAt = 0, historyBusy = false, nextHistoryAt = 0;
let lastReceivedAt = 0, lastPublishedAt = 0, lastSocketEventAt = 0;
let historyError = null, historyTruncated = false;
const HISTORY_FILE = path.join(STATE_DIR, "history-cursor.json");
const historySaved = readConfig(HISTORY_FILE);
const historyFloor = Number(historySaved.since || Date.now() / 1000);
let historySince = historyFloor, historyScan = historySaved.pending || null;
const journal = new SlackJournal(path.join(STATE_DIR, "delivery"));
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
  const connected = socket?.readyState === WebSocket.OPEN;
  const queue = journal.stats();
  const deliveryAttention = queue.attention > 0 || queue.oldestPendingAgeMs > 60000 || (state === "degraded" && queue.pending > 0);
  if (state !== healthState) {
    healthState = state;
    lastTransitionAt = now;
  }
  const value = {
    state: healthState,
    mode: MODE,
    channelId: CHANNEL_ID,
    connected,
    restartRecommended: !connected,
    deliveryState: deliveryAttention ? "attention_required" : (queue.pending ? "pending" : "idle"),
    updatedAt: now,
    heartbeatAt: now,
    lastTransitionAt,
    runtimeRoot: path.dirname(path.resolve(process.argv[1] || ".")),
    pid: process.pid,
    queue, lastReceivedAt, lastPublishedAt, lastSocketEventAt,
    historyError, historyTruncated,
    ...extra,
  };
  const temp = `${HEALTH_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, HEALTH_FILE);
}

async function slackApi(method, token, body = {}) {
  const { response, value } = await fetchJson(`${SLACK_API_BASE}/${method}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  }, HTTP_TIMEOUT_MS);
  if (!response.ok || !value.ok) {
    const error = new Error(`slack_api_${method}:${value.error || response.status}`);
    error.retryAfter = Number(response.headers.get("retry-after") || 0);
    error.status = response.status;
    throw error;
  }
  return value;
}

async function bridgeCall(payload, lookup = false) {
  const { response, value } = await fetchJson(
    lookup ? `${BRIDGE_URL}/requests/${encodeURIComponent(payload.requestId)}` : `${BRIDGE_URL}/requests`,
    lookup ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    lookup ? HTTP_TIMEOUT_MS : BRIDGE_TIMEOUT_MS,
  );
  if (lookup && response.status === 404 && value.error === "request_not_found") return null;
  if (!response.ok) {
    const error = new Error(`bridge_http_${response.status}:${value.error || "unknown"}`);
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw error;
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
  if (receipt?.result && typeof receipt.result === "object") {
    const { command, ...result } = receipt.result;
    receipt = { ...receipt, result };
  }
  const payload = JSON.stringify(receipt);
  const requestId = receipt?.requestId || "unknown";
  const state = receipt?.state || "unknown";
  const prefix = `CLAW_RPC_RESULT_V1 request=${requestId} state=${state}\n`;
  if (prefix.length + payload.length + 12 <= MAX_REPLY_CHARS) {
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
    truncated: true,
    resultChars: JSON.stringify(result).length,
    execution: {
      success: result.success, exitCode: result.exitCode,
      timedOut: result.timedOut, durationMs: result.durationMs,
    },
    receiptPath: /^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
      ? path.join(os.homedir(), ".openclaw", "remote-bridge", "requests", requestId + ".json")
      : undefined,
    preview: String(result.preview ?? result.stdout ?? result.text ?? JSON.stringify(result)).slice(0, 8000),
    stderrPreview: String(result.stderr || "").slice(0, 1000),
  };
  // JSON escaping can inflate a preview. Keep the entire reply bounded.
  while (prefix.length + JSON.stringify(summary).length + 20 > MAX_REPLY_CHARS && summary.preview.length) {
    summary.preview = summary.preview.slice(0, Math.floor(summary.preview.length / 2));
  }
  return prefix + "```json\n" + JSON.stringify(summary) + "\n```";
}

function allowedEvent(event) {
  return event?.type === "message" && !event.subtype && !event.bot_id && event.user !== botUserId &&
    event.channel === CHANNEL_ID && ALLOWED_USERS.has(String(event.user || ""));
}

function receive(event) {
  if (!allowedEvent(event)) return null;
  const previous = journal.get(event.channel, event.ts);
  if (previous) return previous;
  let request;
  try {
    request = parseRpc(event.text);
    if (!request) return null;
    if (Buffer.byteLength(JSON.stringify(request)) > 65536) throw new Error("request_too_large");
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(request.requestId || "")) throw new Error("invalid_request_id");
  } catch (error) {
    if (!String(event.text || "").trim().startsWith("CLAW_RPC_V1")) return null;
    return journal.add(event, null, `CLAW_RPC_ERROR_V1 code=${sanitizeAuditText(error.message)} action=use_b64`);
  }
  lastReceivedAt = Date.now();
  auditEvent("request", request, { mode: MODE });
  if (MODE !== "active" && !READ_ONLY.has(String(request.method || ""))) {
    return journal.add(event, request, compactReply({ requestId: request.requestId, state: "rejected_shadow" }));
  }
  return journal.add(event, request);
}

function retry(row, error) {
  const attempts = row.attempts + 1;
  const delay = Math.max(Number(error.retryAfter || 0) * 1000, Math.min(30000, 1000 * 2 ** attempts));
  journal.update(row, { attempts, nextAt: Date.now() + delay,
    state: attempts >= MAX_ATTEMPTS ? "attention_required" : row.state,
    lastError: sanitizeAuditText(error.message).slice(0, 250) });
  writeHealth("degraded", { lastError: sanitizeAuditText(error.message).slice(0, 250) });
}

function verifyReceipt(request, receipt) {
  if (!receipt) return null;
  const hash = createHash("sha256").update(JSON.stringify({ method: request.method, params: request.params || {} })).digest("hex");
  if (receipt.method !== request.method || receipt.paramsHash !== hash ||
      (request.taskId && receipt.taskId && request.taskId !== receipt.taskId) ||
      (request.stepId && receipt.stepId && request.stepId !== receipt.stepId)) {
    const error = new Error("receipt_conflict"); error.permanent = true; throw error;
  }
  return receipt;
}

async function execute(row) {
  activeRequests.add(row.key);
  try {
    // Restart/network retry: recover the canonical receipt before any submission.
    let receipt = row.state === "submitted" ? verifyReceipt(row.request, await bridgeCall(row.request, true)) : null;
    if (!receipt) {
      row = journal.update(row, { state: "submitted" });
      receipt = await bridgeCall(row.request);
    }
    if (receipt.state === "running" || receipt.state === "received") {
      if (Date.now() - row.createdAt < 180000) {
        journal.update(row, { nextAt: Date.now() + 1500 }); return;
      }
      // Report the true running state; never turn a timeout into execution failure.
    }
    auditEvent("result", row.request, { state: receipt.state, durationMs: Date.now() - row.createdAt });
    journal.update(row, { state: "reply_pending", text: compactReply(receipt), attempts: 0,
      nextAt: 0, resultAt: Date.now() });
  } catch (error) {
    if (error.permanent) {
      journal.update(row, { state: "reply_pending", text: compactReply({ requestId: row.request.requestId,
        state: "rejected", error: error.message }), attempts: 0, nextAt: 0 });
    } else retry(row, error);
  } finally { activeRequests.delete(row.key); }
}

async function publish(row) {
  publishing = true;
  try {
    const posted = await slackApi("chat.postMessage", BOT_TOKEN, {
      channel: row.channel, thread_ts: row.threadTs, text: row.text,
      unfurl_links: false, unfurl_media: false,
    });
    lastPublishedAt = Date.now();
    auditEvent("published", row.request, { queueMs: lastPublishedAt - (row.resultAt || row.createdAt) });
    journal.delivered(row, posted.ts);
  } catch (error) {
    // A 429 applies to the API's publication budget, not only this one message.
    nextPostAt = Math.max(nextPostAt, Date.now() + Number(error.retryAfter || 0) * 1000);
    retry(row, error);
  } finally { nextPostAt = Math.max(nextPostAt, Date.now() + POST_INTERVAL_MS); publishing = false; }
}

function drain() {
  if (stopping || !botUserId) return;
  for (const row of journal.rows.values()) {
    if (row.state === "delivered" || row.state === "attention_required" || row.nextAt > Date.now()) continue;
    if (row.channel !== CHANNEL_ID || !ALLOWED_USERS.has(row.user)) {
      journal.update(row, { state: "attention_required", lastError: "owner_or_channel_changed" }); continue;
    }
    if (row.state === "reply_pending") {
      if (!publishing && Date.now() >= nextPostAt) void publish(row);
    } else if (!activeRequests.has(row.key) && activeRequests.size < 4) {
      if (MODE !== "active" && !READ_ONLY.has(row.request?.method)) {
        journal.update(row, { state: "attention_required", lastError: "shadow_mode" }); continue;
      }
      void execute(row);
    }
  }
}

function saveHistory() {
  fs.writeFileSync(HISTORY_FILE + ".tmp", JSON.stringify({ since: historySince, pending: historyScan }), { mode: 0o600 });
  fs.renameSync(HISTORY_FILE + ".tmp", HISTORY_FILE);
}

async function reconcileHistory() {
  if (historyBusy || stopping || !botUserId || Date.now() < nextHistoryAt) return;
  historyBusy = true; nextHistoryAt = Date.now() + 60000;
  const began = Date.now(), until = Date.now() / 1000 - 5;
  historyScan ||= { oldest: String(Math.max(historyFloor, historySince - 30, until - 300)), latest: String(until), cursor: "" };
  saveHistory();
  try {
    // Paginated, bounded catch-up. Never execute a previously unseen command.
    for (let pageNo = 0; pageNo < 3; pageNo++) {
      const page = await slackApi("conversations.history", BOT_TOKEN, {
        channel: CHANNEL_ID, oldest: historyScan.oldest, latest: historyScan.latest,
        cursor: historyScan.cursor || undefined, limit: 100,
      });
      for (const event of page.messages || []) {
        event.channel = CHANNEL_ID;
        if (!allowedEvent(event) || journal.get(event.channel, event.ts)) continue;
        let request;
        try { request = parseRpc(event.text); } catch { continue; }
        if (!request || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.requestId || "")) continue;
        if (Date.now() - began > 15000) throw new Error("history_budget_exhausted");
        let receipt;
        try { receipt = verifyReceipt(request, await bridgeCall(request, true)); }
        catch (error) {
          if (!error.permanent) throw error;
          receipt = { requestId: request.requestId, state: "rejected", error: error.message };
        }
        if (journal.get(event.channel, event.ts)) continue;
        journal.add(event, request, compactReply(receipt || { requestId: request.requestId,
          state: "not_received", error: "Request absent from Bridge; revalidate intent, then resubmit the same requestId." }));
      }
      const cursor = page.response_metadata?.next_cursor || "";
      historyTruncated = !!page.has_more || !!cursor;
      if (!historyTruncated) {
        historySince = Number(historyScan.latest); historyScan = null; saveHistory(); break;
      }
      if (!cursor) throw new Error("history_truncated_without_cursor");
      historyScan.cursor = cursor; saveHistory();
      if (Date.now() - began > 15000) break;
    }
    historyError = null;
  } catch (error) {
    historyError = sanitizeAuditText(error.message).slice(0, 200);
    nextHistoryAt = Math.max(nextHistoryAt, Date.now() + Number(error.retryAfter || 0) * 1000);
  } finally { historyBusy = false; }
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
    const handshakeTimer = setTimeout(() => {
      if (socket === currentSocket && currentSocket.readyState !== WebSocket.OPEN) scheduleReconnect("socket_open_timeout");
    }, HTTP_TIMEOUT_MS);
    currentSocket.addEventListener("open", () => clearTimeout(handshakeTimer), { once: true });
    currentSocket.addEventListener("close", () => clearTimeout(handshakeTimer), { once: true });
    currentSocket.addEventListener("open", () => {
      if (socket !== currentSocket) return;
      reconnectAttempt = 0;
      auditEvent("socket_open", null);
      writeHealth("healthy", { botUserId });
      nextHistoryAt = 0;
      void reconcileHistory();
    });
    currentSocket.addEventListener("message", (message) => {
      if (socket !== currentSocket) return;
      void handleSocketMessage(String(message.data || ""), currentSocket).catch(error => {
        writeHealth("degraded", { lastError: sanitizeAuditText(error.message).slice(0, 250) });
      });
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

async function handleSocketMessage(raw, sourceSocket) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return;
  }
  lastSocketEventAt = Date.now();
  // Persist allowed RPC input before acknowledging Slack's delivery envelope.
  if (envelope.type === "events_api") receive(envelope.payload?.event);
  if (envelope.envelope_id && sourceSocket?.readyState === WebSocket.OPEN) {
    sourceSocket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
  }
  if (envelope.type === "disconnect") {
    scheduleReconnect("slack_disconnect");
    return;
  }
  if (envelope.type === "events_api") {
    drain();
  }
}

function scheduleReconnect(reason) {
  if (stopping || reconnectTimer) return;
  const previousSocket = socket;
  socket = null;
  try { previousSocket?.close(); } catch {}
  reconnectAttempt += 1;
  auditEvent("socket_reconnect", null, { reason: sanitizeAuditText(reason).slice(0, 160) });
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
  if (!stopping) {
    const backlog = journal.stats();
    const unhealthy = backlog.attention > 0 || backlog.oldestPendingAgeMs > 60000;
    const state = socket?.readyState === WebSocket.OPEN ? (unhealthy ? "degraded" : "healthy") : healthState;
    writeHealth(state, botUserId ? { botUserId } : {});
    void reconcileHistory();
  }
}, Math.max(5000, HEALTH_HEARTBEAT_MS));
healthHeartbeat.unref();
const drainTimer = setInterval(drain, 100);
drainTimer.unref();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
writeHealth("starting");
void connect();
