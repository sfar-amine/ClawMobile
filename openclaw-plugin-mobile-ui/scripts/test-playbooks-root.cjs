// Single code root (Amine 02/11/2026): the Companion reads the activated playbooks pin; the workspace copy is an
// alerted fallback that never blocks. Same event format as installer/termux-lite/code_root.py.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "playbooks-root-"));
const originalHome = os.homedir;
const saved = { CLAW_UI_PLAYBOOKS_ROOT: process.env.CLAW_UI_PLAYBOOKS_ROOT };
const quiet = console.warn;
try {
  os.homedir = () => root;
  delete process.env.CLAW_UI_PLAYBOOKS_ROOT;
  console.warn = () => {};
  const { playbooksRootFor, recordCodeRootEvent } = require("../dist/companion/playbooksRoot");
  const { playbooksRoot } = require("../dist/companion/voiceRoundLearning");
  const pin = path.join(root, ".openclaw/runtime-ui-playbooks/current");
  const snapshot = path.join(root, ".openclaw/runtime-ui-playbooks", "a".repeat(40));
  const workspace = path.join(root, ".openclaw/workspace/ui-playbooks");
  const events = path.join(root, ".openclaw/health/code-root/events");
  const put = (dir, rel) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), ""); };
  const req = "skill_intelligence/improvement.py";
  let checks = 0;

  // Nothing anywhere: the workspace spelling is kept as the last resort (previous default), event recorded.
  assert.equal(playbooksRootFor("voice_round_learning", req), workspace);
  assert.equal(playbooksRoot(), null); checks += 2;
  fs.rmSync(events, { recursive: true, force: true });

  put(workspace, req); put(snapshot, req); fs.symlinkSync(snapshot, pin);
  // Pin present: pin, link spelling kept (a later activation is followed), no event.
  assert.equal(playbooksRootFor("mcp_bridge", req), pin);
  assert.equal(playbooksRoot(), pin);
  assert.equal(fs.existsSync(events), false); checks += 3;

  // Pin missing: workspace, never blocking, one throttled event.
  fs.unlinkSync(pin);
  assert.equal(playbooksRootFor("mcp_bridge", req), workspace);
  const event = JSON.parse(fs.readFileSync(path.join(events, "mcp_bridge.json"), "utf8"));
  assert.deepEqual([event.component, event.event, event.reason, event.root], ["mcp_bridge", "fallback", "pin_missing", workspace]);
  const mtime = fs.statSync(path.join(events, "mcp_bridge.json")).mtimeMs;
  assert.equal(recordCodeRootEvent("mcp_bridge", workspace), false);
  assert.equal(fs.statSync(path.join(events, "mcp_bridge.json")).mtimeMs, mtime);
  assert.equal(recordCodeRootEvent("mcp_bridge", workspace, "pin_missing", root, Date.now() + 11 * 60_000), true);
  assert.equal(playbooksRoot(), workspace); checks += 6;
  assert.equal(recordCodeRootEvent("../escape", workspace), false); checks += 1;

  // Overrides: as given by default (legacy CLAW_UI_PLAYBOOKS_ROOT semantics), or only when they carry the file.
  const custom = path.join(root, "custom");
  assert.equal(playbooksRootFor("x", req, { overrides: [undefined, custom] }), custom);
  fs.symlinkSync(snapshot, pin);
  assert.equal(playbooksRootFor("x", req, { overrides: [custom], overridesMustContain: true }), pin);
  process.env.CLAW_UI_PLAYBOOKS_ROOT = custom;
  assert.equal(playbooksRoot(), pin, "voice round capture ignores an override without the owner module"); checks += 3;
  delete process.env.CLAW_UI_PLAYBOOKS_ROOT;

  // Callers resolve per call through the shared resolver; no module-level workspace default is left.
  const src = (name) => fs.readFileSync(path.join(__dirname, "../src/companion", name), "utf8");
  for (const name of ["mcpBridge.ts", "voiceRoundLearning.ts", "control.ts"]) {
    assert.match(src(name), /playbooksRootFor\(/, name);
    assert.doesNotMatch(src(name), /"workspace", "ui-playbooks"|workspace\/ui-playbooks/, name);
    checks += 2;
  }
  assert.doesNotMatch(src("mcpBridge.ts"), /const UI_PLAYBOOKS =/); checks += 1;
  console.log(`playbooks root: ${checks} checks passed (pin first, alerted workspace fallback, never blocking)`);
} finally {
  console.warn = quiet;
  os.homedir = originalHome;
  if (saved.CLAW_UI_PLAYBOOKS_ROOT === undefined) delete process.env.CLAW_UI_PLAYBOOKS_ROOT; else process.env.CLAW_UI_PLAYBOOKS_ROOT = saved.CLAW_UI_PLAYBOOKS_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
}
