const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const mod = require("../dist/companion/capabilityBridge.js");
  const tempBase = path.join(os.homedir(), ".openclaw", "tmp");
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, "capability-bridge-test-"));
  const helper = path.join(root, "helper.py");
  fs.writeFileSync(helper, [
    "import json,sys",
    "print(json.dumps({'surface':sys.argv[sys.argv.index('--surface')+1],'selected':{'executor':'bixby.device'}}))",
    "",
  ].join("\n"));

  const out = await mod.capabilityBridge("active le wifi", {
    helperPath: helper,
    surface: "bixby",
    execute: false,
  });
  assert.equal(out.success, true);
  assert.equal(out.surface, "bixby");
  assert.equal(out.selected.executor, "bixby.device");

  const empty = await mod.capabilityBridge("", { helperPath: helper });
  assert.equal(empty.success, false);
  assert.equal(empty.error, "request_required");

  console.log("capability-bridge tests: PASS");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
