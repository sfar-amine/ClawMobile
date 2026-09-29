const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const tmpRoot = process.env.TMPDIR || path.join(os.homedir(), ".cache", "tmp");
fs.mkdirSync(tmpRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tmpRoot, "claw-core-test-"));
const bridgeDir = path.join(root, "bridge");
const testFile = path.join(root, "file.txt");
const binaryFile = path.join(root, "binary.bin");
const node = path.join(os.homedir(), ".openclaw-android", "bin", "node");
const companion = path.resolve(__dirname, "..", "dist", "companion", "server.js");
const base = "http://127.0.0.1:8880/v1/extensions/remote-bridge";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await wait(25);
  }
  throw new Error("timeout");
}

async function request(method, route, payload) {
  const response = await fetch(base + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });  let body;
  try { body = await response.json(); }
  catch { body = {}; }
  return { code: response.status, body };
}

function submit(payload) {
  return request("POST", "/requests", payload);
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
  const proc = spawn(node, [companion], {
    env: {
      ...process.env,
      CLAWMOBILE_COMPANION_PORT: "8880",
      CLAWMOBILE_WHATSAPP_LISTENER_WATCHDOG: "0",
      CLAWMOBILE_CHATGPT_VOICE_RECOVERY: "0",
      CLAWMOBILE_REMOTE_BRIDGE_DIR: bridgeDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitFor(async () => {
    try {
      return (await request("GET", "/health")).body.ok === true;
    } catch {
      return false;
    }
  });  let result = await submit({
    requestId: "core-ping",
    method: "ping",
    params: {},
  });
  assert.equal(result.code, 200);
  assert.equal(result.body.state, "completed");

  const write = {
    requestId: "core-write",
    method: "write_file",
    params: { path: testFile, content: "X", mode: "append" },
  };
  result = await submit(write);
  assert.equal(result.body.state, "completed");
  assert.equal(fs.readFileSync(testFile, "utf8"), "X");
  result = await submit(write);
  assert.equal(result.body.state, "completed");
  assert.equal(fs.readFileSync(testFile, "utf8"), "X");

  result = await submit({
    ...write,
    params: { path: testFile, content: "Y", mode: "append" },
  });
  assert.equal(result.code, 409);

  fs.chmodSync(testFile, 0o755);
  result = await submit({
    requestId: "core-patch",
    method: "patch_file",
    params: { path: testFile, oldBase64: Buffer.from("X").toString("base64"), newBase64: Buffer.from("Y").toString("base64"), expectedReplacements: 1 },
  });
  assert.equal(result.body.state, "completed");
  assert.equal(result.body.mutationRisk, "write");
  assert.equal(fs.readFileSync(testFile, "utf8"), "Y");
  assert.equal(fs.statSync(testFile).mode & 0o777, 0o755);

  const binaryBase64 = "AP8KDYAB";
  result = await submit({ requestId: "core-binary-write", method: "write_binary_file", params: { path: binaryFile, dataBase64: binaryBase64, mode: "rewrite" } });
  assert.equal(result.body.state, "completed");
  result = await submit({ requestId: "core-binary-read", method: "read_binary_file", params: { path: binaryFile, offset: 0, maxBytes: 16 } });
  assert.equal(result.body.result.dataBase64, binaryBase64);

  result = await submit({
    requestId: "core-exec",
    method: "exec_wait",
    params: { command: "printf hello && printf world" },
  });
  assert.equal(result.body.result.stdout, "helloworld");
  assert.equal(result.body.result.exitCode, 0);  result = await submit({
    requestId: "core-process",
    method: "process_start",
    params: { command: "printf A && sleep 0.2 && printf B" },
  });
  const processId = result.body.result.processId;
  await wait(350);
  result = await submit({
    requestId: "core-process-status",
    method: "process_status",
    params: { processId, offset: 0 },
  });
  assert.equal(result.body.result.state, "completed");
  assert.equal(result.body.result.output, "AB");

  result = await submit({
    requestId: "core-large",
    method: "exec_wait",
    params: { command: "python3 -c 'print(\"Z\"*70000)'" },
  });
  const artifactId = result.body.result.artifact.artifactId;
  assert.ok(result.body.result.artifact.bytes > 70000);
  result = await submit({
    requestId: "core-artifact",
    method: "artifact_read",
    params: { artifactId, offset: 0, maxBytes: 100 },
  });
  assert.equal(result.body.result.text.length, 100);  const requestsDir = path.join(bridgeDir, "requests");
  const stale = {
    requestId: "core-stale",
    method: "exec_wait",
    paramsHash: "x",
    state: "running",
    instanceId: "old-instance",
    receivedAt: Date.now() - 1000,
    startedAt: Date.now() - 900,
    mutationRisk: "unknown",
  };
  fs.writeFileSync(
    path.join(requestsDir, "core-stale.json"),
    JSON.stringify(stale),
  );
  result = await request("GET", "/requests/core-stale");
  assert.equal(result.body.state, "indeterminate");

  console.log(JSON.stringify({
    ok: true,
    idempotentWrite: true,
    requestConflict: true,
    execWait: true,
    processStreaming: true,
    artifact: true,
    patchFile: true,
    binaryRoundTrip: true,
    staleRunningFailsClosed: true,
  }));

  await stop(proc);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
