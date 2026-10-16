// F6 (fichiers 35/41) : reçus Remote Bridge bloqués -> `abandoned` borné, sans rejeu,
// sur les 16 reçus réels de fixtures/s24-2026-10-11b/f6 et 50 000 reçus terminés.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const tmpRoot = process.env.TMPDIR || os.tmpdir();
const root = fs.mkdtempSync(path.join(tmpRoot, "claw-f6-"));
const bridgeDir = path.join(root, "remote-bridge");
const requestsDir = path.join(bridgeDir, "requests");
const processDir = path.join(bridgeDir, "processes");
fs.mkdirSync(requestsDir, { recursive: true });
fs.mkdirSync(processDir, { recursive: true });
process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR = bridgeDir;
process.env.CLAW_CONTINUUM_FOREGROUND_DIR = path.join(root, "continuum");

const bridge = require(path.resolve(__dirname, "..", "dist", "companion", "remoteBridge.js"));
const fixture = require(path.resolve(__dirname, "..", "fixtures", "s24-2026-10-11b", "f6", "remote-bridge-stuck-receipts.json"));
const HOUR = 3600 * 1000;
assert.strictEqual(bridge.REMOTE_BRIDGE_ABANDON_AFTER_MS, HOUR);

function deadPid() {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  const pid = Number(String(child.stdout));
  try { process.kill(pid, 0); throw new Error("pid still alive"); } catch (error) { assert.strictEqual(error.code, "ESRCH"); }
  return pid;
}
function instance(pid) { return `${pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`; }
function hash(method, params) { return crypto.createHash("sha256").update(JSON.stringify({ method, params })).digest("hex"); }
function write(receipt, mtimeMs) {
  const file = path.join(requestsDir, `${receipt.requestId}.json`);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  if (mtimeMs) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}
function read(requestId) { return JSON.parse(fs.readFileSync(path.join(requestsDir, `${requestId}.json`), "utf8")); }

const originalReaddirSync = fs.readdirSync;
let alive, survivor;
(async () => {
  try {
  const now = Date.now();
  const stuck = fixture.receipts.filter((row) => !row.note);
  assert.strictEqual(stuck.length, 16, "16 reçus bloqués dans la capture");

  // 1. Les 16 reçus réels : instances différentes, pid absents, 4,2 h à 250,9 h.
  const real = stuck.map((row, index) => {
    const origin = now - Math.round(row.ageHours * HOUR);
    const receipt = {
      requestId: `f6-real-${index}`,
      method: row.method,
      paramsHash: row.paramsHash,
      state: row.state,
      instanceId: instance(deadPid()),
      receivedAt: origin,
      startedAt: origin,
      mutationRisk: row.mutationRisk,
      ...(row.state === "indeterminate" ? { completedAt: origin + 1000, error: "Bridge restarted while request was running. Verify effect before retry." } : {}),
    };
    write(receipt, origin);
    return { receipt, origin };
  });

  // 2. Reçu « received » d'une instance morte : dispatch jamais commencé.
  const receivedOrigin = now - 2 * HOUR;
  write({ requestId: "f6-received", method: "exec_wait", paramsHash: "x", state: "received", instanceId: instance(deadPid()), receivedAt: receivedOrigin, mutationRisk: "unknown" });

  // 3. Instance morte mais reçu récent (< 1 h) : pas encore terminal.
  write({ requestId: "f6-young", method: "exec_wait", paramsHash: "x", state: "running", instanceId: instance(deadPid()), receivedAt: now - 10 * 60 * 1000, startedAt: now - 10 * 60 * 1000, mutationRisk: "unknown" });

  // 4. Instance vivante (pid existant) : jamais abandonné.
  // Lifetime is controlled by the test, not by time spent writing 50 000 files.
  alive = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  write({ requestId: "f6-alive", method: "exec_wait", paramsHash: "x", state: "running", instanceId: instance(alive.pid), receivedAt: now - 5 * HOUR, startedAt: now - 5 * HOUR, mutationRisk: "unknown" });

  // 5. Instance morte, mais script exec_wait encore dans une ligne de commande vivante.
  const scriptStart = now - 3 * HOUR;
  const script = path.join(processDir, `cmd-${scriptStart}-deadbeef.sh`);
  fs.writeFileSync(script, "read -r release\n", { mode: 0o700 });
  survivor = spawn("sh", [script], { stdio: ["pipe", "ignore", "ignore"] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  write({ requestId: "f6-live-command", method: "exec_wait", paramsHash: "x", state: "running", instanceId: instance(deadPid()), receivedAt: scriptStart, startedAt: scriptStart, mutationRisk: "unknown" });

  // 6. Volume réaliste : 50 000 reçus terminés, jamais modifiés.
  const filler = JSON.stringify({ requestId: "", method: "ping", paramsHash: "p", state: "completed", instanceId: "1-1-00000000", receivedAt: 1, completedAt: 2, mutationRisk: "read" });
  for (let i = 0; i < 50000; i++) fs.writeFileSync(path.join(requestsDir, `done-${i}.json`), filler.replace('"requestId":""', `"requestId":"done-${i}"`));

  // Isolated synthetic /proc directory view for this fixture: the child PIDs
  // and their cmdline files are real. Unrelated host processes are not evidence
  // about these synthetic receipts, especially on a reused CI host >4096 PIDs.
  process.kill(alive.pid, 0);
  process.kill(survivor.pid, 0);
  assert.ok(fs.readFileSync(`/proc/${survivor.pid}/cmdline`, "utf8").includes(script));
  fs.readdirSync = (dir, ...args) => String(dir) === "/proc"
    ? [String(process.pid), String(alive.pid), String(survivor.pid)]
    : originalReaddirSync(dir, ...args);

  const started = Date.now();
  const sweep = bridge.abandonStaleRemoteBridgeReceipts({ budgetMs: 10000 });
  const elapsed = Date.now() - started;
  assert.strictEqual(sweep.state, "complete", JSON.stringify(sweep));
  assert.ok(elapsed < 10000, `balayage borné (${elapsed} ms)`);
  assert.strictEqual(sweep.abandoned, 17, JSON.stringify(sweep));
  assert.strictEqual(sweep.notAppliedVerified, 1);
  assert.strictEqual(sweep.effectUncertain, 16);
  assert.strictEqual(sweep.keptAlive, 3);
  assert.deepStrictEqual(bridge.remoteBridgeHealth().abandonSweep, sweep, "résumé du balayage exposé dans la santé existante");

  for (const { receipt, origin } of real) {
    const after = read(receipt.requestId);
    assert.strictEqual(after.state, "abandoned");
    assert.strictEqual(after.mutationRisk, "unknown", "le risque reste visible");
    assert.strictEqual(after.abandonment.application, "effect_uncertain");
    assert.strictEqual(after.abandonment.previousState, receipt.state);
    assert.strictEqual(after.abandonment.reason, "owner_instance_gone");
    assert.strictEqual(after.abandonment.ownerInstanceAlive, false);
    assert.ok(after.abandonment.ageMs >= HOUR);
    assert.strictEqual(after.startedAt, receipt.startedAt);
    assert.match(after.error, /Effect unknown/);
    const mtime = fs.statSync(path.join(requestsDir, `${receipt.requestId}.json`)).mtimeMs;
    assert.ok(Math.abs(mtime - origin) < 2000, "mtime d'origine conservé");
  }
  const received = read("f6-received");
  assert.strictEqual(received.state, "abandoned");
  assert.strictEqual(received.abandonment.application, "not_applied_verified");
  assert.match(received.error, /Not applied/);
  assert.strictEqual(read("f6-young").state, "running");
  assert.strictEqual(read("f6-alive").state, "running");
  assert.strictEqual(read("f6-live-command").state, "running");
  assert.strictEqual(read("done-123").state, "completed");

  // 7. Lecture paresseuse : même règle ; reçu récent -> indeterminate (comportement existant).
  assert.strictEqual(bridge.getRemoteBridgeRequest("f6-young").state, "indeterminate");
  assert.strictEqual(bridge.getRemoteBridgeRequest("f6-alive").state, "indeterminate", "autre instance : indeterminate, jamais abandoned");
  const lazyOrigin = now - 4 * HOUR; // hors de la fenêtre ±10 s du script vivant (cas 5)
  write({ requestId: "f6-lazy", method: "exec_wait", paramsHash: "x", state: "running", instanceId: instance(deadPid()), receivedAt: lazyOrigin, startedAt: lazyOrigin, mutationRisk: "write" });
  const lazy = bridge.getRemoteBridgeRequest("f6-lazy");
  assert.strictEqual(lazy.state, "abandoned");
  assert.strictEqual(lazy.mutationRisk, "write");

  // 8. Sans rejeu : resoumettre la même requête renvoie le reçu terminal, sans dispatch.
  const marker = path.join(root, "replayed.txt");
  const params = { command: `echo replay > ${marker}`, timeoutMs: 2000 };
  write({ requestId: "f6-replay", method: "exec_wait", paramsHash: hash("exec_wait", params), state: "running", instanceId: instance(deadPid()), receivedAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, mutationRisk: "unknown" });
  const replay = await bridge.submitRemoteBridgeRequest({ requestId: "f6-replay", method: "exec_wait", params });
  assert.strictEqual(replay.state, "abandoned");
  assert.strictEqual(replay.abandonment.application, "effect_uncertain");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(fs.existsSync(marker), false, "aucun rejeu de la commande");
  const again = await bridge.submitRemoteBridgeRequest({ requestId: "f6-replay", method: "exec_wait", params });
  assert.deepStrictEqual(again, read("f6-replay"), "abandoned est terminal et stable");

  // Fresh owner module: an inventory above the unchanged 4096-PID bound must
  // be unknown, never proof that a running command has disappeared.
  write({ requestId: "f6-proc-overflow", method: "exec_wait", paramsHash: "x", state: "running", instanceId: instance(deadPid()), receivedAt: now - 6 * HOUR, startedAt: now - 6 * HOUR, mutationRisk: "unknown" });
  const overflowCheck = spawnSync(process.execPath, ["-e", `
    const assert = require("assert"), fs = require("fs");
    const real = fs.readdirSync;
    let procReads = 0;
    const read = fs.readFileSync;
    fs.readdirSync = (dir, ...args) => String(dir) === "/proc" ? Array.from({length:4097}, (_,i)=>String(i+1)) : real(dir,...args);
    fs.readFileSync = (file, ...args) => { if (String(file).startsWith("/proc/")) procReads++; return read(file,...args); };
    const owner = require(process.argv[1]);
    const result = owner.getRemoteBridgeRequest("f6-proc-overflow");
    assert.strictEqual(result.state, "indeterminate");
    assert.strictEqual(result.abandonment, undefined);
    assert.strictEqual(procReads, 0, "incomplete inventory must not be partially scanned");
  `, path.resolve(__dirname, "..", "dist", "companion", "remoteBridge.js")], { timeout: 10000, encoding: "utf8" });
  assert.strictEqual(overflowCheck.status, 0, overflowCheck.stderr);
  assert.strictEqual(read("f6-proc-overflow").state, "indeterminate");
  console.log(JSON.stringify({ ok: true, test: "remote-bridge-abandoned", sweepMs: elapsed, abandoned: sweep.abandoned, procOverflowUnknown: true }));
  } finally {
    fs.readdirSync = originalReaddirSync;
    alive?.kill("SIGKILL");
    survivor?.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
