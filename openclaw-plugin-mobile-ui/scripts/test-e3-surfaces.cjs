// 38 E3 / T5, then SAM-MIG-CC-001 V2.2 (L5). Since the ADR of 02/11 (« le cerveau partout », step 3) the owner's
// WhatsApp, voice relay and Gemini Live turns go to the brain: none of them is a surface of the dialogue coordinator
// any more (the contact rooms still are, see test-contact-room-fast-path). What remains here: the Gemini Live tool
// contract and the static INV-01 / T-M04 invariants.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const live = require("../dist/companion/clawLive.js");

async function main() {
  let checks = 0;

  // --- Gemini Live (Claw Live): browser tool contract ---
  {
    const setup = live.buildClawLiveSetup("gemini-3.8-live", { home: os.tmpdir() }).setup;
    const decl = setup.tools[0].functionDeclarations[0];
    assert.ok(decl.parameters.properties.clarificationId); assert.deepEqual(decl.parameters.required, ["request"]); checks += 2;
    assert.match(setup.systemInstruction.parts[0].text, /needs_clarification, read its question aloud verbatim/); checks++;
    const html = live.clawLivePageHtml();
    assert.match(html, /request:original\|\|String\(args\?\.request/); assert.match(html, /heard\+=sc\.inputTranscription\.text/); checks += 2;
  }

  // --- INV-01 / T-M04 (static): the three former authorities are gone from the sources ---
  {
    const src = path.join(__dirname, "../src");
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && files.push(p); } };
    walk(src);
    const all = files.map((f) => [f, fs.readFileSync(f, "utf8")]);
    assert.equal(fs.existsSync(path.join(src, "capabilityClarification.ts")), false); checks++;
    for (const [file, text] of all) {
      assert.doesNotMatch(text, /SurfaceClarifications|findPendingClarificationRun|whatsappClarifications|clarificationDecision: pending/, file);
    }
    checks++;
    // T-O02: hook replies go back as the hook text (OpenClaw durable queue); no direct send from the plugin.
    for (const [file, text] of all) assert.doesNotMatch(text, /sendDurableMessageBatch|delivery-queue-runtime/, file);
    checks++;
    // T-B04 (core side): no surface reads or writes the coordinator's private store.
    for (const [file, text] of all) assert.doesNotMatch(text, /dialogue\.sqlite/, file);
    checks++;
    // ADR 02/11 step 3: the owner's surfaces no longer open a coordinator turn before the brain.
    for (const owner of ["modelFastPath.ts", "companion/intent.ts", "companion/voiceRelay.ts", "companion/clawLive.ts", "companion/clawLiveUnderstanding.ts"])
      assert.doesNotMatch(fs.readFileSync(path.join(src, owner), "utf8"), /DialogueSurface|dialogueTurn|dialogueTurnUntilReady/, owner);
    checks++;
    const lite = fs.readFileSync(path.join(__dirname, "prepare-lite.mjs"), "utf8");
    assert.match(lite, /capabilityClarification\.js/, "a stale dist copy of the former authority is removed at build"); checks++;
  }

  console.log(`E3 surfaces (Gemini Live contract, owner surfaces off the coordinator, static INV-01): ${checks} checks passed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
