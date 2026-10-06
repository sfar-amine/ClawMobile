function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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
