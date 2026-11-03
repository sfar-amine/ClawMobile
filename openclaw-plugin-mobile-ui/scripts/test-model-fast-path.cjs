const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const mod = require("../dist/modelFastPath.js");

  // ADR 02/11 « le cerveau partout », step 3: the owner's turns no longer pass through this runner before the brain.
  for (const name of ["isOwnerFastPathEligible", "isTrustedLocalCompanionSession", "handleOwnerFastPath", "handleOwnerBeforeDispatch"])
    assert.equal(mod[name], undefined, name);

  const helperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capability-first-test-"));
  const helper = path.join(helperRoot, "helper.py");
  fs.writeFileSync(helper, [
    "import json,sys",
    "print(json.dumps({'status':'hit','text':'helper-ok','argv':sys.argv[1:]}))",
    "",
  ].join("\n"));
  const helperResult = await mod.runModelFastPath("hello", {
    helperPath: helper,
    surface: "claw_live",
    caller: "owner",
    originId: "run-helper",
    timeoutSeconds: 10,
  });
  assert.equal(helperResult.status, "hit");
  assert.equal(helperResult.text, "helper-ok");
  assert.deepEqual(helperResult.argv, [
    "--surface", "claw_live",
    "--caller", "owner",
    "--origin-id", "run-helper",
    "--timeout", "10",
    "hello",
  ]);
  // --dialogue: event and policy travel base64-encoded, never on the command line.
  fs.writeFileSync(helper, [
    "import base64,json,os,sys",
    "ev=json.loads(base64.b64decode(os.environ['CLAW_DIALOGUE_EVENT_B64']))",
    "po=json.loads(base64.b64decode(os.environ['CLAW_DIALOGUE_POLICY_B64']))",
    "print(json.dumps({'outcome':'COMPLETED','text':'ok','argv':sys.argv[1:],'event':ev,'policy':po}))",
    "",
  ].join("\n"));
  const dialogueResult = await mod.runModelFastPath("bonjour", {
    helperPath: helper, surface: "whatsapp", caller: "owner", originId: "wamid-1", timeoutSeconds: 75,
    dialogue: { mode: "handoff", goalRef: "goal-0123456789abcdef0123", event: { surface: "whatsapp", conversationKey: "k", eventRef: "wamid-1" }, policy: { modelAllowed: true } },
  });
  assert.deepEqual(dialogueResult.argv, ["--dialogue", "handoff", "--goal-ref", "goal-0123456789abcdef0123", "--surface", "whatsapp", "--caller", "owner", "--origin-id", "wamid-1", "--timeout", "75", "bonjour"]);
  assert.equal(dialogueResult.event.conversationKey, "k");
  assert.deepEqual(dialogueResult.policy, { modelAllowed: true });
  fs.rmSync(helperRoot, { recursive: true, force: true });

  // Owner WhatsApp numbers (commands.ownerAllowFrom) still identify the owner for native turn observation.
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-cfg-"));
  const cfgPath = path.join(cfgDir, "openclaw.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ commands: { ownerAllowFrom: ["whatsapp:+21610000001", "slack:U1", "+21699"] } }));
  assert.deepEqual([...mod.ownerWhatsAppNumbers(cfgPath)], ["+21610000001"]);
  assert.deepEqual([...mod.ownerWhatsAppNumbers(path.join(cfgDir, "missing.json"))], []);
  const indexSource = fs.readFileSync(path.join(__dirname, "../src/index.ts"), "utf8");
  assert.doesNotMatch(indexSource, /handleOwnerBeforeDispatch|handleOwnerFastPath|"inbound_claim"/);
  fs.rmSync(cfgDir, { recursive: true, force: true });

  console.log("capability-first plugin tests: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
