const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const tmpRoot = process.env.TMPDIR || path.join(os.homedir(), ".cache", "tmp");
fs.mkdirSync(tmpRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tmpRoot, "claw-core-test-"));
const bridgeDir = path.join(root, "bridge");
const testFile = path.join(root, "file.txt");
const stepFile = path.join(root, "step.txt");
const binaryFile = path.join(root, "binary.bin");
const continuumDir = path.join(root, "continuum");
const node = path.join(os.homedir(), ".openclaw-android", "bin", "node");

function bridgeParamsHash(method, params) {
  return crypto.createHash("sha256").update(JSON.stringify({ method, params })).digest("hex");
}

function makeContinuumState({ taskId, stepId, attemptId, requestId, effectKey, method, params,
  epoch = 1, ownerId = "owner-a", bootId = "boot-a", leaseUntil = Date.now() / 1000 + 120 }) {
  const fence = { version: 1, attemptId, effectKey, ownershipEpoch: epoch, ownerId, bootId };
  return {
    version: 3, run_id: taskId, state: "running",
    owner: { id: ownerId, boot_id: bootId, lease_until: leaseUntil },
    continuum: { control: "active", ownership_epoch: epoch, current_attempt: attemptId, attempts: {
      [attemptId]: { state: "submitted", request_id: requestId, effect_key: effectKey,
        transport_binding: { version: 1, taskId, stepId, requestId, method, paramsHash: bridgeParamsHash(method, params) },
        dispatch_fence: fence },
    } },
  };
}

function writeContinuumState(state, projection = state) {
  fs.mkdirSync(continuumDir, { recursive: true });
  fs.writeFileSync(path.join(continuumDir, state.run_id + ".json"), JSON.stringify(projection));
  fs.writeFileSync(path.join(continuumDir, state.run_id + ".events.jsonl"),
    JSON.stringify({ taskId: state.run_id, after: state }) + "\n");
}
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
      CLAW_CONTINUUM_FOREGROUND_DIR: continuumDir,
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

  const stepWrite = {
    requestId: "core-step-write-1",
    taskId: "task-a",
    stepId: "append-once",
    method: "write_file",
    params: { path: stepFile, content: "S", mode: "append" },
  };
  result = await submit(stepWrite);
  assert.equal(result.body.state, "completed");
  result = await submit({ ...stepWrite, requestId: "core-step-write-2", sessionId: "other-session" });
  assert.equal(result.body.requestId, "core-step-write-1");
  assert.equal(fs.readFileSync(stepFile, "utf8"), "S");
  result = await submit({
    ...stepWrite,
    requestId: "core-step-write-conflict",
    params: { path: stepFile, content: "T", mode: "append" },
  });
  assert.equal(result.code, 409);
  result = await submit({
    requestId: "core-task-status",
    method: "task_status",
    params: { taskId: "task-a" },
  });
  assert.equal(result.body.mutationRisk, "read");
  assert.equal(result.body.result.total, 1);
  assert.equal(result.body.result.receipts[0].stepId, "append-once");
  assert.equal(result.body.result.receipts[0].requestId, "core-step-write-1");

  // Continuum effect-boundary fence: executor validates the latest journal state
  // immediately before creating a new receipt/dispatching the mutation.
  const fencedFile = path.join(root, "continuum-fenced.txt");
  const fencedParams = { path: fencedFile, content: "F", mode: "append" };
  const fencedTask = "continuum-task";
  const fencedStep = "continuum-step";
  const fencedAttempt = "attempt-1";
  const fencedRequest = "continuum-write";
  const fencedEffect = "effect-1";
  let fencedState = makeContinuumState({ taskId: fencedTask, stepId: fencedStep,
    attemptId: fencedAttempt, requestId: fencedRequest, effectKey: fencedEffect,
    method: "write_file", params: fencedParams });
  writeContinuumState(fencedState);
  const fencedEnvelope = { requestId: fencedRequest, taskId: fencedTask, stepId: fencedStep,
    method: "write_file", params: fencedParams,
    continuumFence: fencedState.continuum.attempts[fencedAttempt].dispatch_fence };
  result = await submit(fencedEnvelope);
  assert.equal(result.code, 200);
  assert.equal(result.body.state, "completed");
  assert.deepEqual(result.body.continuumFence,
    { version: 1, attemptId: fencedAttempt, effectKey: fencedEffect, ownershipEpoch: 1 });
  assert.equal(fs.readFileSync(fencedFile, "utf8"), "F");

  // A newer owner epoch cannot cause the old duplicate to replay: existing
  // receipt wins first and the file remains append-once.
  fencedState = makeContinuumState({ taskId: fencedTask, stepId: fencedStep,
    attemptId: fencedAttempt, requestId: fencedRequest, effectKey: fencedEffect,
    method: "write_file", params: fencedParams, epoch: 2, ownerId: "owner-b", bootId: "boot-b" });
  writeContinuumState(fencedState);
  result = await submit(fencedEnvelope);
  assert.equal(result.code, 200);
  assert.equal(result.body.requestId, fencedRequest);
  assert.equal(fs.readFileSync(fencedFile, "utf8"), "F");

  const staleFile = path.join(root, "continuum-stale.txt");
  const staleParams = { path: staleFile, content: "S", mode: "append" };
  const staleState = makeContinuumState({ taskId: "continuum-stale-task", stepId: "stale-step",
    attemptId: "stale-attempt", requestId: "stale-request", effectKey: "stale-effect",
    method: "write_file", params: staleParams, epoch: 2, ownerId: "owner-b", bootId: "boot-b" });
  writeContinuumState(staleState);
  result = await submit({ requestId: "stale-request", taskId: "continuum-stale-task",
    stepId: "stale-step", method: "write_file", params: staleParams,
    continuumFence: { version: 1, attemptId: "stale-attempt", effectKey: "stale-effect",
      ownershipEpoch: 1, ownerId: "owner-a", bootId: "boot-a" } });
  assert.equal(result.code, 409);
  assert.equal(fs.existsSync(staleFile), false);

  const missingFenceFile = path.join(root, "continuum-missing-fence.txt");
  const missingFenceParams = { path: missingFenceFile, content: "M", mode: "append" };
  const missingFenceState = makeContinuumState({ taskId: "continuum-missing-task", stepId: "missing-step",
    attemptId: "missing-attempt", requestId: "missing-request", effectKey: "missing-effect",
    method: "write_file", params: missingFenceParams });
  writeContinuumState(missingFenceState);
  result = await submit({ requestId: "missing-request", taskId: "continuum-missing-task",
    stepId: "missing-step", method: "write_file", params: missingFenceParams });
  assert.equal(result.code, 409);
  assert.equal(fs.existsSync(missingFenceFile), false);

  const expiredFile = path.join(root, "continuum-expired.txt");
  const expiredParams = { path: expiredFile, content: "E", mode: "append" };
  const expiredState = makeContinuumState({ taskId: "continuum-expired-task", stepId: "expired-step",
    attemptId: "expired-attempt", requestId: "expired-request", effectKey: "expired-effect",
    method: "write_file", params: expiredParams, leaseUntil: Date.now() / 1000 - 1 });
  writeContinuumState(expiredState);
  result = await submit({ requestId: "expired-request", taskId: "continuum-expired-task",
    stepId: "expired-step", method: "write_file", params: expiredParams,
    continuumFence: expiredState.continuum.attempts["expired-attempt"].dispatch_fence });
  assert.equal(result.code, 409);
  assert.equal(fs.existsSync(expiredFile), false);

  // Journal tail is execution truth if projection lags after journal-first crash.
  const journalFile = path.join(root, "continuum-journal-truth.txt");
  const journalParams = { path: journalFile, content: "J", mode: "append" };
  const journalCurrent = makeContinuumState({ taskId: "continuum-journal-task", stepId: "journal-step",
    attemptId: "journal-attempt", requestId: "journal-request", effectKey: "journal-effect",
    method: "write_file", params: journalParams, epoch: 2, ownerId: "owner-b", bootId: "boot-b" });
  const staleProjection = makeContinuumState({ taskId: "continuum-journal-task", stepId: "journal-step",
    attemptId: "journal-attempt", requestId: "journal-request", effectKey: "journal-effect",
    method: "write_file", params: journalParams, epoch: 1, ownerId: "owner-a", bootId: "boot-a" });
  writeContinuumState(journalCurrent, staleProjection);
  result = await submit({ requestId: "journal-request", taskId: "continuum-journal-task",
    stepId: "journal-step", method: "write_file", params: journalParams,
    continuumFence: staleProjection.continuum.attempts["journal-attempt"].dispatch_fence });
  assert.equal(result.code, 409);
  assert.equal(fs.existsSync(journalFile), false);

  // Read methods stay compatible and do not require an effect fence.
  result = await submit({ requestId: "continuum-read", taskId: fencedTask,
    stepId: "continuum-read-step", method: "read_file",
    params: { path: fencedFile, offset: 0, length: 10 } });
  assert.equal(result.code, 200);
  assert.equal(result.body.result.text, "F");

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
    requestId: "core-quiet-process",
    taskId: "task-quiet",
    stepId: "long-test",
    method: "process_start",
    params: { command: "sleep 0.6" },
  });
  const quietProcessId = result.body.result.processId;
  await wait(50);
  result = await submit({
    requestId: "core-quiet-status-1",
    method: "process_status",
    params: { processId: quietProcessId, offset: 0 },
  });
  assert.equal(result.body.result.state, "running");
  assert.equal(result.body.result.output, "");
  await wait(700);
  result = await submit({
    requestId: "core-quiet-status-2",
    method: "process_status",
    params: { processId: quietProcessId, offset: 0 },
  });
  assert.equal(result.body.result.state, "completed");

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

  const processesDir = path.join(bridgeDir, "processes");
  fs.mkdirSync(processesDir, { recursive: true });
  fs.writeFileSync(path.join(processesDir, "proc-stale.json"), JSON.stringify({
    processId: "proc-stale",
    ownerInstanceId: "old-process-owner",
    command: "sleep 10",
    cwd: root,
    startedAt: Date.now() - 1000,
    state: "running",
    pid: 999999,
  }));
  fs.writeFileSync(path.join(processesDir, "proc-stale.log"), "");
  result = await submit({
    requestId: "core-stale-process-status",
    method: "process_status",
    params: { processId: "proc-stale", offset: 0 },
  });
  assert.equal(result.body.result.state, "indeterminate");
  assert.equal(JSON.parse(fs.readFileSync(path.join(processesDir, "proc-stale.json"), "utf8")).state, "indeterminate");

  console.log(JSON.stringify({
    ok: true,
    idempotentWrite: true,
    taskStepDedup: true,
    taskStatus: true,
    requestConflict: true,
    execWait: true,
    processStreaming: true,
    silentProcessStaysRunning: true,
    staleProcessFailsClosed: true,
    artifact: true,
    patchFile: true,
    binaryRoundTrip: true,
    staleRunningFailsClosed: true,
    continuumFenceAccepted: true,
    continuumStaleEpochRejected: true,
    continuumFenceRequired: true,
    continuumJournalTailAuthoritative: true,
  }));

  await stop(proc);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
