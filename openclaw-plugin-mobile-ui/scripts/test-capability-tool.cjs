const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const mod = require("../dist/capabilityTool.js");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "openclaw.plugin.json"), "utf8"),
  );
  assert.equal(
    manifest.contracts.tools.includes("clawmobile_capability"),
    true,
    "plugin manifest must declare clawmobile_capability for strict tool allowlists",
  );
  const tempBase = path.join(os.homedir(), ".openclaw", "tmp");
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, "claw-capability-test-"));
  const helper = path.join(root, "helper.py");
  fs.writeFileSync(helper, [
    "import json,sys",
    "print(json.dumps({'capability_revision':'rev1','surface':sys.argv[sys.argv.index('--surface')+1],'caller':sys.argv[sys.argv.index('--caller')+1],'selected':{'executor':'claw.skill_route'},'execution':{'state':'completed'}}))",
    "",
  ].join("\n"));

  const result = await mod.clawmobile_capability(
    { request: "mon solde orange", execute: true, surface: "gemini_claw", caller: "owner" },
    { helperPath: helper },
  );
  assert.equal(result.status, "ok");
  assert.equal(result.surface, "gemini_claw");
  assert.equal(result.caller, "owner");
  assert.equal(result.selected.executor, "claw.skill_route");

  const missing = await mod.clawmobile_capability({ request: "" }, { helperPath: helper });
  assert.equal(missing.status, "error");
  assert.equal(missing.reason, "request_required");

  console.log("capability-tool tests: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
