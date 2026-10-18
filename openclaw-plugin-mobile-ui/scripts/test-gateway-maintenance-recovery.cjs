const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Bounded wait that never outlives the test: a refused lease used to leave only
// an unref'd timer, so Node exited 0 before any assertion ran.
function within(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Same isolation as test-qa-runtime-repair-lease.cjs: temporary OPENCLAW_HOME
// for the canonical lock, temporary homedir for Tier0's current link. The real
// ~/.openclaw is never read or locked.
const root = path.resolve(__dirname, "../../installer/termux-lite");
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "samantha-runtime-lease-"));
fs.mkdirSync(path.join(testHome, "deploys"));
fs.writeFileSync(path.join(testHome, "deploys/companion-deploy.lock"), "", { mode: 0o600 });
process.env.OPENCLAW_HOME = testHome;
const originalHomeDir = os.homedir;
os.homedir = () => testHome;
const current = path.join(testHome, ".openclaw/releases/current/termux-lite");
fs.mkdirSync(path.dirname(current), { recursive: true });
fs.symlinkSync(root, current, "dir");
let completed = false;
process.on("exit", (code) => {
  os.homedir = originalHomeDir;
  fs.rmSync(testHome, { recursive: true, force: true });
  if (code === 0 && !completed) {
    console.error("gateway maintenance recovery test ended before all assertions ran");
    process.exitCode = 1;
  }
});

(async () => {
  const gateway = require("../dist/companion/openclawGatewayClient.js");

  assert(
    gateway.runtimeLogNeedsMaintenance("x gateway.maintenance_required y"),
    "maintenance marker not detected",
  );
  assert(
    gateway.runtimeLogNeedsMaintenance("requires state migration"),
    "state migration marker not detected",
  );
  assert(
    !gateway.runtimeLogNeedsMaintenance("ordinary connection refused"),
    "ordinary failure misclassified",
  );

  assert(
    gateway.isGatewayRuntimeCommand("/data/data/com.termux/files/usr/glibc/lib/ld-linux-aarch64.so.1 openclaw-gateway"),
    "gateway binary must be recognized",
  );
  assert(
    gateway.isGatewayRuntimeCommand("/data/data/com.termux/files/usr/bin/bash /opt/claw/gateway-start.sh"),
    "gateway start script must be recognized",
  );
  assert(
    gateway.isGatewayRuntimeCommand("node /opt/openclaw/openclaw.mjs gateway --bind loopback"),
    "OpenClaw gateway CLI must be recognized",
  );
  assert(
    !gateway.isGatewayRuntimeCommand("/data/data/com.termux/files/usr/bin/bash -l -c echo openclaw-gateway"),
    "diagnostic login shell must not become a gateway owner",
  );
  assert(
    !gateway.isGatewayRuntimeCommand("bash -c grep gateway-start.sh /tmp/log"),
    "shell text mentioning the launcher must not become a gateway owner",
  );

  const down = { host: "127.0.0.1", port: 18789, reachable: false, message: "down" };
  const up = { host: "127.0.0.1", port: 18789, reachable: true, message: "up" };
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  let releaseFirst;
  let firstCalls = 0;
  const first = gateway.runSerializedRuntimeOperation(
    "restart",
    () => new Promise((resolve) => {
      firstCalls += 1;
      firstStarted();
      releaseFirst = () => resolve({ success: true, state: "running", message: "done", gateway: up });
    }),
    async () => down,
  );
  await within(Promise.race([
    started,
    first.then((result) => { throw new Error(`runtime mutation did not start: ${result.message}`); }),
  ]), 4000, "lease did not start");
  let secondCalls = 0;
  const busy = await gateway.runSerializedRuntimeOperation(
    "start",
    async () => {
      secondCalls += 1;
      return { success: true, state: "running", message: "unexpected", gateway: up };
    },
    async () => down,
  );
  assert(firstCalls === 1, "first runtime mutation must execute once");
  assert(secondCalls === 0, "overlapping runtime mutation must not execute");
  assert(busy.success === false && busy.message.includes("restart"), "busy response must identify the active mutation");
  releaseFirst();
  await first;
  const after = await gateway.runSerializedRuntimeOperation(
    "start",
    async () => {
      secondCalls += 1;
      return { success: true, state: "running", message: "done", gateway: up };
    },
    async () => down,
  );
  assert(after.success === true && secondCalls === 1, "runtime mutation lock must release after completion");

  // Tier0 current link absent (not installed yet, or pruned): no helper, no mutation.
  fs.unlinkSync(current);
  let unguarded = 0;
  const unavailable = await gateway.runSerializedRuntimeOperation("restart", async () => {
    unguarded += 1;
    return { success: true, state: "running", message: "unexpected", gateway: up };
  }, async () => down);
  assert(unguarded === 0, "mutation must not execute without the lease helper");
  assert(!unavailable.success && unavailable.message.includes("could not be verified"), "absent current must fail closed");
  fs.symlinkSync(root, current, "dir");

  let doctors = 0;
  let waits = 0;
  let result = await gateway.runBoundedStartupMaintenanceRepair({
    gatewayReachable: async () => true,
    gatewayOwnerPids: async () => [],
    runDoctor: async () => { doctors += 1; },
    wait: async () => { waits += 1; },
  });
  assert(result.success === true, "already-recovered gateway should succeed");
  assert(doctors === 0, "doctor must not run when gateway already recovered");

  doctors = 0;
  result = await gateway.runBoundedStartupMaintenanceRepair({
    gatewayReachable: async () => false,
    gatewayOwnerPids: async () => [1234],
    runDoctor: async () => { doctors += 1; },
    wait: async () => { waits += 1; },
  });
  assert(result.success === false, "live owner must fail closed");
  assert(doctors === 0, "doctor must not run while gateway owner exists");

  doctors = 0;
  waits = 0;
  result = await gateway.runBoundedStartupMaintenanceRepair({
    gatewayReachable: async () => false,
    gatewayOwnerPids: async () => [],
    runDoctor: async () => {
      doctors += 1;
      if (doctors === 1) throw new Error("first failure");
    },
    wait: async () => { waits += 1; },
  });
  assert(result.success === true, "second bounded doctor attempt should recover");
  assert(doctors === 2, "doctor retry count must be exactly two");
  assert(waits === 1, "there must be exactly one inter-attempt wait");

  doctors = 0;
  result = await gateway.runBoundedStartupMaintenanceRepair({
    gatewayReachable: async () => false,
    gatewayOwnerPids: async () => [],
    runDoctor: async () => {
      doctors += 1;
      throw new Error("persistent failure");
    },
    wait: async () => {},
  }, 99);
  assert(result.success === false, "persistent failure must fail closed");
  assert(doctors === 2, "caller cannot widen the two-attempt repair budget");

  completed = true;
  console.log("gateway maintenance recovery test passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
