function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "samantha-runtime-lease-"));
  fs.mkdirSync(path.join(testHome, "deploys"));
  fs.writeFileSync(path.join(testHome, "deploys/companion-deploy.lock"), "", { mode: 0o600 });
  process.env.OPENCLAW_HOME = testHome;
  process.env.CLAW_RUNTIME_ROOT = path.resolve(__dirname, "../../installer/termux-lite");
  process.on("exit", () => fs.rmSync(testHome, { recursive: true, force: true }));
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
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("lease did not start")), 4000).unref())]);
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

  const savedRoot = process.env.CLAW_RUNTIME_ROOT;
  process.env.CLAW_RUNTIME_ROOT = "relative-root";
  const unavailable = await gateway.runSerializedRuntimeOperation("restart", async () => {
    throw new Error("mutation must not execute with invalid canonical root");
  }, async () => down);
  assert(!unavailable.success && unavailable.message.includes("could not be verified"), "relative root must fail closed");
  process.env.CLAW_RUNTIME_ROOT = savedRoot;

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

  console.log("gateway maintenance recovery test passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
