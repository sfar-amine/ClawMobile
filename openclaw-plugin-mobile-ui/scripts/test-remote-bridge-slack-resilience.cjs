const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const tmpRoot = process.env.TMPDIR || path.join(os.homedir(), ".cache", "tmp");
fs.mkdirSync(tmpRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tmpRoot, "claw-slack-resilience-"));
const bridgeDir = path.join(root, "bridge");
const slackState = path.join(root, "slack");
const node = path.join(os.homedir(), ".openclaw-android", "bin", "node");
const companion = path.resolve(__dirname, "..", "dist", "companion", "server.js");
const adapter = path.resolve(__dirname, "..", "..", "installer", "termux-lite", "claw-slack-bridge.mjs");
let sockets = new Set();
let connectionCount = 0;
let envelopeSeq = 0;
let postAttempts = 0;
let successfulPosts = 0;
let rateLimitOnce = true;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await wait(25);
  }
  throw new Error("timeout");
}
function json(res, value, status = 200, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

const apiServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const route = req.url || "";
    if (route === "/api/auth.test") return json(res, { ok: true, user_id: "UBOT" });
    if (route === "/api/apps.connections.open") {
      return json(res, { ok: true, url: "ws://127.0.0.1:8893/" });
    }
    if (route === "/api/chat.postMessage") {
      postAttempts += 1;
      if (rateLimitOnce) {
        rateLimitOnce = false;
        return json(res, { ok: false, error: "ratelimited" }, 429, { "retry-after": "1" });
      }
      successfulPosts += 1;
      return json(res, { ok: true, channel: "CTEST", ts: String(Date.now()) });
    }
    return json(res, { ok: false, error: "unknown_method" });
  });
});

const wss = new WebSocketServer({ port: 8893 });
wss.on("connection", (ws) => {
  connectionCount += 1;
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
  ws.send(JSON.stringify({ type: "hello", num_connections: sockets.size }));
});
function sendEvent(requestId) {
  const ws = [...sockets][0];
  if (!ws) throw new Error("no_socket");
  envelopeSeq += 1;
  const envelopeId = "env-" + envelopeSeq;
  ws.send(JSON.stringify({
    type: "events_api",
    envelope_id: envelopeId,
    payload: {
      event: {
        type: "message",
        channel: "CTEST",
        user: "UOWNER",
        ts: String(1800000000 + envelopeSeq),
        text: "CLAW_RPC_V1\n" + JSON.stringify({
          requestId,
          method: "ping",
          params: {},
        }),
      },
    },
  }));
}

function startCompanion() {
  return spawn(node, [companion], {
    env: {
      ...process.env,
      CLAWMOBILE_COMPANION_PORT: "8879",
      CLAWMOBILE_WHATSAPP_LISTENER_WATCHDOG: "0",
      CLAWMOBILE_CHATGPT_VOICE_RECOVERY: "0",
      CLAWMOBILE_REMOTE_BRIDGE_DIR: bridgeDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function startAdapter() {
  return spawn(node, [adapter], {
    env: {
      ...process.env,
      CLAW_SLACK_APP_TOKEN: "xapp-test",
      CLAW_SLACK_BOT_TOKEN: "xoxb-test",
      CLAW_SLACK_CHANNEL_ID: "CTEST",
      CLAW_SLACK_ALLOWED_USER_IDS: "UOWNER",
      CLAW_SLACK_MODE: "active",
      CLAW_SLACK_API_BASE: "http://127.0.0.1:8892/api",
      CLAW_SLACK_BRIDGE_URL: "http://127.0.0.1:8879/v1/extensions/remote-bridge",
      CLAW_SLACK_STATE_DIR: slackState,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function httpJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return await response.json();
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(1000),
  ]);
}
async function main() {
  await new Promise((resolve) => apiServer.listen(8892, "127.0.0.1", resolve));
  const companionProc = startCompanion();
  await waitFor(async () => {
    try {
      return (await httpJson("http://127.0.0.1:8879/v1/extensions/remote-bridge/health")).ok;
    } catch {
      return false;
    }
  });
  const adapterProc = startAdapter();
  await waitFor(() => sockets.size === 1);

  sendEvent("resilience-rate-limit");
  await waitFor(() => successfulPosts === 1, 5000);
  assert.ok(postAttempts >= 2);

  const firstConnectionCount = connectionCount;
  const current = [...sockets][0];
  current.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
  await waitFor(() => connectionCount > firstConnectionCount, 6000);
  await waitFor(() => sockets.size === 1, 3000);

  sendEvent("resilience-reconnect");
  await waitFor(() => successfulPosts === 2, 4000);

  const health = JSON.parse(fs.readFileSync(path.join(slackState, "health.json"), "utf8"));
  assert.equal(health.state, "healthy");
  assert.equal(health.connected, true);

  console.log(JSON.stringify({
    ok: true,
    rateLimitRetried: postAttempts >= 2,
    reconnects: connectionCount - 1,
    successfulPosts,
    health: health.state,
  }));

  await stop(adapterProc);
  await stop(companionProc);
  await new Promise((resolve) => apiServer.close(resolve));
  await new Promise((resolve) => wss.close(resolve));
}
main().catch(async (error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
