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
    "import base64,json,sys",
    "mode=sys.argv[1]",
    "if mode=='execute-decision':",
    " decision=json.loads(base64.b64decode(sys.argv[sys.argv.index('--decision-b64')+1]).decode())",
    " ref=json.loads(sys.argv[sys.argv.index('--dialogue-read-handoff')+1]) if '--dialogue-read-handoff' in sys.argv else None",
    " print(json.dumps({'mode':mode,'decisionId':decision.get('decisionId'),'handoff':ref,'text':sys.argv[2],'readOnly':'--read-only' in sys.argv,'execution':{'state':'completed','result':{'ok':True}}}))",
    "else:",
    " target=sys.argv[sys.argv.index('--target')+1] if '--target' in sys.argv else None",
    " print(json.dumps({'surface':sys.argv[sys.argv.index('--surface')+1],'target':target,'harness':{'tool_policy':'required','evidence_required':True,'shortlist':[{'id':'device.assistance','score':1.0}]},'selected':{'executor':'bixby.device'}}))",
    "",
  ].join("\n"));

  const out = await mod.capabilityBridge("active le wifi", {
    helperPath: helper,
    surface: "bixby",
    execute: false,
    targetHint: "maxit-tunisie",
  });
  assert.equal(out.success, true);
  assert.equal(out.surface, "bixby");
  assert.equal(out.target, "maxit-tunisie");
  assert.equal(out.selected.executor, "bixby.device");
  assert.equal(out.harness.tool_policy, "required");
  assert.equal(out.harness.evidence_required, true);
  assert.equal(out.harness.shortlist[0].id, "device.assistance");

  const decision = {version:2,type:"EXECUTE",decisionId:"decision-1",requestId:"request-1"};
  const executed = await mod.capabilityBridge("active le wifi", {
    helperPath: helper, surface: "claw_live", caller: "owner", execute: true, decision,
  });
  assert.equal(executed.success, true);
  assert.equal(executed.mode, "execute-decision");
  assert.equal(executed.decisionId, "decision-1");
  assert.equal(executed.execution.state, "completed");

  const handoff={conversationRef:'conv-fixture',goalRef:'goal-fixture',eventKey:'event-fixture',originId:'origin-fixture',revision:1};
  const reading=await mod.capabilityBridge('  etat de mes factures  ',{helperPath:helper,execute:true,readOnly:true,caller:'owner',decision,dialogueReadHandoff:handoff});
  assert.equal(reading.success,true);assert.deepEqual(reading.handoff,handoff);
  assert.equal(reading.text,'  etat de mes factures  ');assert.equal(reading.readOnly,true);
  for(const change of [{readOnly:false},{caller:'other'},{dialogueReadHandoff:[]},{dialogueReadHandoff:{x:'x'.repeat(3000)}}]){
    const refused=await mod.capabilityBridge('read',{helperPath:helper,execute:true,readOnly:true,caller:'owner',decision,dialogueReadHandoff:handoff,...change});
    assert.equal(refused.success,false);assert.equal(refused.error,'intent_read_handoff_invalid');
  }

  const invalidTarget = await mod.capabilityBridge("test", { helperPath: helper, targetHint: "bad target" });
  assert.equal(invalidTarget.success, false);
  assert.equal(invalidTarget.error, "invalid_target_hint");

  const empty = await mod.capabilityBridge("", { helperPath: helper });
  assert.equal(empty.success, false);
  assert.equal(empty.error, "request_required");

  console.log("capability-bridge tests: PASS");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
