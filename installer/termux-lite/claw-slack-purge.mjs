#!/data/data/com.termux/files/home/.openclaw-android/bin/node
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const HOME = os.homedir();
const STATE_DIR = process.env.CLAW_SLACK_STATE_DIR || path.join(HOME, ".openclaw", "remote-bridge", "slack");
const CONFIG_PATH = process.env.CLAW_SLACK_CONFIG || path.join(STATE_DIR, "config.json");
const RECEIPT_DIR = process.env.CLAW_REMOTE_BRIDGE_REQUEST_DIR || path.join(HOME, ".openclaw", "remote-bridge", "requests");
const LOG_FILE = process.env.CLAW_SLACK_PURGE_LOG || path.join(HOME, ".openclaw", "health", "slack_purge.log");
const API_BASE = (process.env.CLAW_SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const NON_TERMINAL = new Set(["running", "indeterminate", "received", "pending"]);

export function parseRpcRequestId(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("CLAW_RPC_V1")) return "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return "";
  try {
    const payload = JSON.parse(raw.slice(start, end + 1));
    return typeof payload?.requestId === "string" ? payload.requestId : "";
  } catch {
    return "";
  }
}

export function isReceiptPurgeable(receipt) {
  const state = String(receipt?.state || "").toLowerCase();
  return Boolean(state) && !NON_TERMINAL.has(state);
}

export function isOlderThan(ts, cutoffSeconds) {
  const value = Number(ts || 0);
  return Number.isFinite(value) && value > 0 && value < cutoffSeconds;
}

function readJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function readSecret(filePath) {
  if (!filePath) return "";
  try {
    const resolved = String(filePath).replace(/^~(?=\/|$)/, HOME);
    return fs.readFileSync(resolved, "utf8").trim();
  } catch {
    return "";
  }
}

async function slackApi(method, token, body = {}, formEncoded = false) {
  const headers = { Authorization: `Bearer ${token}` };
  let encodedBody;
  if (formEncoded) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    encodedBody = new URLSearchParams(
      Object.entries(body).filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)]),
    );
  } else {
    headers["Content-Type"] = "application/json; charset=utf-8";
    encodedBody = JSON.stringify(body);
  }
  const response = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers,
    body: encodedBody,
  });
  let value = {};
  try { value = await response.json(); } catch {}
  if (!response.ok || !value.ok) {
    const error = new Error(value.error || `http_${response.status}`);
    error.retryAfter = Number(response.headers.get("retry-after") || 0);
    throw error;
  }
  return value;
}

async function withRetry(method, token, body, formEncoded = false) {
  try {
    return await slackApi(method, token, body, formEncoded);
  } catch (error) {
    if (!error.retryAfter) throw error;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1000, error.retryAfter * 1000)));
    return await slackApi(method, token, body, formEncoded);
  }
}

async function listOldParents(channel, botToken, cutoffSeconds) {
  const messages = [];
  let cursor = "";
  do {
    const body = { channel, limit: 100, latest: String(cutoffSeconds), inclusive: false };
    if (cursor) body.cursor = cursor;
    const page = await withRetry("conversations.history", botToken, body);
    messages.push(...(Array.isArray(page.messages) ? page.messages : []));
    cursor = String(page.response_metadata?.next_cursor || "").trim();
  } while (cursor);
  return messages;
}

async function listThread(channel, ts, botToken) {
  const out = [];
  let cursor = "";
  do {
    const body = { channel, ts, limit: 100 };
    if (cursor) body.cursor = cursor;
    const page = await withRetry("conversations.replies", botToken, body, true);
    out.push(...(Array.isArray(page.messages) ? page.messages : []));
    cursor = String(page.response_metadata?.next_cursor || "").trim();
  } while (cursor);
  return out;
}

async function deleteMessage(channel, ts, token) {
  try {
    await withRetry("chat.delete", token, { channel, ts });
    return "deleted";
  } catch (error) {
    if (error.message === "message_not_found") return "already_missing";
    throw error;
  }
}

function receiptFor(requestId) {
  const safe = requestId.replace(/[^A-Za-z0-9._-]/g, "_");
  const filePath = path.join(RECEIPT_DIR, `${safe}.json`);
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath, null);
}

function appendSummary(summary) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const line = `${new Date().toISOString()} [SLACK-PURGE] scanned=${summary.scanned} eligible=${summary.eligible} parents_deleted=${summary.parentsDeleted} replies_deleted=${summary.repliesDeleted} skipped_active=${summary.skippedActive} skipped_foreign=${summary.skippedForeign} skipped_no_user_token=${summary.skippedNoUserToken} failed=${summary.failed}\n`;
  fs.appendFileSync(LOG_FILE, line, "utf8");
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length > 200) fs.writeFileSync(LOG_FILE, lines.slice(-200).join("\n") + "\n", "utf8");
  } catch {}
  process.stdout.write(line);
}

export async function runPurge(options = {}) {
  const config = readJson(CONFIG_PATH, {});
  const botToken = options.botToken || process.env.CLAW_SLACK_BOT_TOKEN || readSecret(process.env.CLAW_SLACK_BOT_TOKEN_FILE || config.botTokenFile || path.join(STATE_DIR, "secrets", "bot-token"));
  const userToken = options.userToken || process.env.CLAW_SLACK_USER_TOKEN || readSecret(process.env.CLAW_SLACK_USER_TOKEN_FILE || config.userTokenFile || path.join(STATE_DIR, "secrets", "user-token"));
  const channel = options.channelId || process.env.CLAW_SLACK_CHANNEL_ID || String(config.channelId || "");
  const ttlSeconds = Number(options.ttlSeconds ?? process.env.CLAW_SLACK_PURGE_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  const nowSeconds = Number(options.nowSeconds ?? Date.now() / 1000);
  const cutoffSeconds = nowSeconds - ttlSeconds;
  const onlyRequestId = String(options.onlyRequestId || "");
  const dryRun = Boolean(options.dryRun);

  if (!botToken || !channel) throw new Error("slack_purge_setup_required");

  const auth = await withRetry("auth.test", botToken, {});
  const botUserId = String(auth.user_id || "");
  const parents = await listOldParents(channel, botToken, cutoffSeconds);
  const summary = {
    scanned: parents.length,
    eligible: 0,
    parentsDeleted: 0,
    repliesDeleted: 0,
    skippedActive: 0,
    skippedForeign: 0,
    skippedNoUserToken: 0,
    failed: 0,
  };

  for (const parent of parents) {
    const requestId = parseRpcRequestId(parent.text);
    if (!requestId || (onlyRequestId && requestId !== onlyRequestId)) {
      summary.skippedForeign += 1;
      continue;
    }
    const receipt = receiptFor(requestId);
    if (!receipt || !isReceiptPurgeable(receipt)) {
      summary.skippedActive += 1;
      continue;
    }

    if (!userToken && String(parent.user || "") !== botUserId && !parent.bot_id) {
      summary.skippedNoUserToken += 1;
      continue;
    }

    let thread;
    try {
      thread = await listThread(channel, parent.ts, userToken || botToken);
    } catch {
      summary.failed += 1;
      continue;
    }

    const replies = thread.slice(1);
    if (replies.some((message) => String(message.user || "") !== botUserId)) {
      summary.skippedForeign += 1;
      continue;
    }
    if (replies.some((message) => !isOlderThan(message.ts, cutoffSeconds))) {
      summary.skippedActive += 1;
      continue;
    }

    summary.eligible += 1;
    if (dryRun) continue;

    for (const reply of replies) {
      if (String(reply.user || "") !== botUserId && !reply.bot_id) {
        continue;
      }
      try {
        const result = await deleteMessage(channel, reply.ts, botToken);
        if (result === "deleted" || result === "already_missing") summary.repliesDeleted += 1;
      } catch {
        summary.failed += 1;
      }
    }

    const parentToken = String(parent.user || "") === botUserId || parent.bot_id ? botToken : userToken;
    if (!parentToken) {
      summary.skippedNoUserToken += 1;
      continue;
    }
    try {
      const result = await deleteMessage(channel, parent.ts, parentToken);
      if (result === "deleted" || result === "already_missing") summary.parentsDeleted += 1;
    } catch {
      summary.failed += 1;
    }
  }

  appendSummary(summary);
  return summary;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--ttl-seconds") options.ttlSeconds = Number(argv[++i]);
    else if (arg === "--only-request-id") options.onlyRequestId = String(argv[++i] || "");
    else if (arg === "--now-seconds") options.nowSeconds = Number(argv[++i]);
  }
  return options;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  runPurge(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`SLACK_PURGE_ERROR ${error.message}\n`);
    process.exitCode = 1;
  });
}
