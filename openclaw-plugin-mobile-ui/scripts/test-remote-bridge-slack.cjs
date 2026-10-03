const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const tmpRoot = process.env.TMPDIR || path.join(os.homedir(), ".cache", "tmp");
fs.mkdirSync(tmpRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tmpRoot, "claw-bridge-test-"));
const bridgeDir = path.join(root, "bridge");
const slackState = path.join(root, "slack");
const testFile = path.join(root, "written.txt");
const b64File = path.join(root, "b64.txt");
const node = path.join(os.homedir(), ".openclaw-android", "bin", "node");
const companion = path.resolve(__dirname, "..", "dist", "companion", "server.js");
const adapter = path.resolve(__dirname, "..", "..", "installer", "termux-lite", "claw-slack-bridge.mjs");
const posts = [];
const sockets = new Set();
let envelopeSeq = 0;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await wait(25);
  }
  throw new Error("timeout");
}function json(res, value) {
  const body = JSON.stringify(value);
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const apiServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const route = req.url || "";
    const body = raw ? JSON.parse(raw) : {};
    if (route === "/api/auth.test") return json(res, { ok: true, user_id: "UBOT" });
    if (route === "/api/apps.connections.open") {
      return json(res, { ok: true, url: "ws://127.0.0.1:8891/" });
    }
    if (route === "/api/chat.postMessage") {
      posts.push(body);
      return json(res, { ok: true, channel: body.channel, ts: String(Date.now()) });
    }
    return json(res, { ok: false, error: "unknown_method" });
  });
});

const wss = new WebSocketServer({ port: 8891 });
wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
  ws.send(JSON.stringify({ type: "hello", num_connections: 1 }));
});function rpcB64(payload) {
  return "CLAW_RPC_V1_B64\n" + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url") + "\u200b\nSent using ChatGPT";
}

function sendEvent(text, options = {}) {
  const ws = [...sockets][0];
  if (!ws) throw new Error("no_socket");
  envelopeSeq += 1;
  const envelopeId = "env-" + envelopeSeq;
  const event = {
    type: "message",
    channel: "CTEST",
    user: options.user || "UOWNER",
    ts: String(1700000000 + envelopeSeq),
    text,
  };
  const ack = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ack_timeout")), 1500);
    const onMessage = (data) => {
      const value = JSON.parse(String(data));
      if (value.envelope_id === envelopeId) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(value);
      }
    };
    ws.on("message", onMessage);
  });
  ws.send(JSON.stringify({
    type: "events_api",
    envelope_id: envelopeId,
    payload: { event },
  }));
  return ack;
}

function startCompanion() {
  return spawn(node, [companion], {
    env: {
      ...process.env,
      CLAWMOBILE_COMPANION_PORT: "8877",
      CLAWMOBILE_WHATSAPP_LISTENER_WATCHDOG: "0",
      CLAWMOBILE_CHATGPT_VOICE_RECOVERY: "0",
      CLAWMOBILE_REMOTE_BRIDGE_DIR: bridgeDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}function startAdapter(mode) {
  return spawn(node, [adapter], {
    env: {
      ...process.env,
      CLAW_SLACK_APP_TOKEN: "xapp-test",
      CLAW_SLACK_BOT_TOKEN: "xoxb-test",
      CLAW_SLACK_CHANNEL_ID: "CTEST",
      CLAW_SLACK_ALLOWED_USER_IDS: "UOWNER",
      CLAW_SLACK_MODE: mode,
      CLAW_SLACK_API_BASE: "http://127.0.0.1:8890/api",
      CLAW_SLACK_BRIDGE_URL: "http://127.0.0.1:8877/v1/extensions/remote-bridge",
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
  await new Promise((resolve) => apiServer.listen(8890, "127.0.0.1", resolve));
  const companionProc = startCompanion();
  await waitFor(async () => {
    try { return (await httpJson("http://127.0.0.1:8877/v1/extensions/remote-bridge/health")).ok; }
    catch { return false; }
  });  let adapterProc = startAdapter("shadow");
  await waitFor(() => sockets.size === 1);

  await sendEvent('CLAW_RPC_V1\n{"requestId":"s-ping","method":"ping","params":{}}');
  await waitFor(() => posts.some((post) => String(post.text).includes("request=s-ping state=completed")));
  assert.equal(posts.length, 1);

  await sendEvent(
    "CLAW_RPC_V1\n" + JSON.stringify({
      requestId: "s-shadow-write",
      method: "write_file",
      params: { path: testFile, content: "X", mode: "append" },
    }),
  );
  await waitFor(() => posts.some((post) => String(post.text).includes("state=rejected_shadow")));
  assert.equal(fs.existsSync(testFile), false);

  await stop(adapterProc);
  sockets.clear();
  adapterProc = startAdapter("active");
  await waitFor(() => sockets.size === 1);

  await sendEvent("CLAW_RPC_V1\\n" + JSON.stringify({
    requestId: "s-entity-exec", method: "exec_wait",
    params: { command: "true &amp;&amp; echo ENTITY_OK" },
  }));
  const entityPost = await waitFor(() => posts.find((post) => String(post.text).includes("request=s-entity-exec state=completed")));
  assert.ok(String(entityPost.text).includes("ENTITY_OK"));

  const complexContent = "line1\n{\\\"quoted\\\":\\\"yes\\\"}";
  await sendEvent(rpcB64({
    requestId: "s-b64-write", method: "write_file",
    params: { path: b64File, content: complexContent, mode: "rewrite" },
  }));
  await waitFor(() => posts.some((post) => String(post.text).includes("request=s-b64-write state=completed")));
  assert.equal(fs.readFileSync(b64File, "utf8"), complexContent);

  const writeRpc = "CLAW_RPC_V1\n" + JSON.stringify({
    requestId: "s-write",
    method: "write_file",
    params: { path: testFile, content: "X", mode: "append" },
  });
  await sendEvent(writeRpc);
  await waitFor(() => posts.filter((post) => String(post.text).includes("request=s-write state=completed")).length === 1);
  assert.equal(fs.readFileSync(testFile, "utf8"), "X");  await sendEvent(writeRpc);
  await waitFor(() => posts.filter((post) => String(post.text).includes("request=s-write state=completed")).length === 2);
  assert.equal(fs.readFileSync(testFile, "utf8"), "X");

  // Regression: 26-48 KB inline results used to become an empty preview.
  await sendEvent(rpcB64({
    requestId: "s-medium-output", method: "exec_wait",
    params: { command: "python -c \"import sys; print('MEDIUM_OUTPUT_' + 'x' * 33000); print('KNOWN_ERROR', file=sys.stderr); sys.exit(7)\"" },
  }));
  const mediumPost = await waitFor(() => posts.find((post) => String(post.text).includes("request=s-medium-output state=completed")));
  assert.ok(mediumPost.text.includes("MEDIUM_OUTPUT_"));
  assert.ok(mediumPost.text.includes("KNOWN_ERROR"));
  assert.ok(mediumPost.text.includes('"exitCode":7'));
  assert.ok(mediumPost.text.includes('"truncated":true'));
  assert.ok(mediumPost.text.length <= 26000);
  assert.ok(JSON.parse(fs.readFileSync(path.join(bridgeDir, "requests", "s-medium-output.json"), "utf8")).result.stdout.length > 33000);

  const before = posts.length;
  await sendEvent(
    'CLAW_RPC_V1\n{"requestId":"s-wrong-user","method":"ping","params":{}}',
    { user: "UOTHER" },
  );
  await wait(300);
  assert.equal(posts.length, before);

  const health = JSON.parse(fs.readFileSync(path.join(slackState, "health.json"), "utf8"));
  assert.equal(health.state, "healthy");
  assert.equal(health.mode, "active");

  console.log(JSON.stringify({
    ok: true,
    posts: posts.length,
    shadowRejected: true,
    b64Rpc: true,
    duplicateWritePrevented: true,
    unauthorizedUserIgnored: true,
    slackHealth: health.state,
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
