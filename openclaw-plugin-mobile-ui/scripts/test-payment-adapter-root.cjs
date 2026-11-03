// Single code root (Amine 02/11/2026, payment adapters approved the same day): root resolution ONLY.
// Pin present -> the pin; pin missing -> the workspace copy plus an alert event; explicit options kept.
// No payment logic is exercised: the stubs answer a read (quote / bill list) and nothing is ever executed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "payment-root-"));
const originalHome = os.homedir;
const quiet = console.warn;
(async () => {
  os.homedir = () => root;
  console.warn = () => {};
  const { createMaxitTopupLivePaymentAdapter } = require("../dist/companion/maxitTopupLivePaymentAdapter.js");
  const { createClicToPayLivePaymentAdapter } = require("../dist/companion/clicToPayLivePaymentAdapter.js");
  const pin = path.join(root, ".openclaw/runtime-ui-playbooks/current");
  const snapshot = path.join(root, ".openclaw/runtime-ui-playbooks", "b".repeat(40));
  const workspace = path.join(root, ".openclaw/workspace/ui-playbooks");
  const events = path.join(root, ".openclaw/health/code-root/events");
  const state = path.join(root, "state");
  const runtime = (dir) => {
    const d = path.join(dir, "billing/direct-runtime"); fs.mkdirSync(d, { recursive: true });
    for (const f of ["maxit-topup-live-cli.mjs", "billing-cli.mjs", "payment-card-cli.mjs", "payment-live-acceptance-cli.mjs"]) fs.writeFileSync(path.join(d, f), "");
  };
  runtime(workspace); runtime(snapshot); fs.symlinkSync(snapshot, pin);
  const ref = "topup-" + "a".repeat(32) + "-" + "b".repeat(32) + "-5";
  const seen = [];
  const liveRun = async (script, payload) => { seen.push([script, payload.operation]); return { state: "blocked", reason_code: "fixture_stop" }; };
  const exec = async (_file, args) => { seen.push([args[0], "read"]); throw new Error("fixture_stop"); };
  const maxitScript = async (options = {}) => {
    seen.length = 0;
    await assert.rejects(createMaxitTopupLivePaymentAdapter({ stateDir: state, liveRun, ...options }).quote(ref), /fixture_stop/);
    assert.deepEqual(seen.map((row) => row[1]), ["quote"], "a quote only, never an execution");
    return seen[0][0];
  };
  const clicScript = async (options = {}) => {
    seen.length = 0;
    const adapter = createClicToPayLivePaymentAdapter({ id: "utility_fixture", label: "Utility", payee: "UTILITY", referencePattern: /^U-[0-9]+$/ },
      { stateDir: state, exec, liveRun, ...options });
    await assert.rejects(adapter.listPayables(), /fixture_stop/);
    assert.deepEqual(seen.map((row) => row[1]), ["read"], "a bill read only, never an execution");
    return seen[0][0];
  };
  let checks = 0;

  // Pin present: both adapters load their CLIs from the pin (link spelling kept), no alert.
  assert.equal(await maxitScript(), path.join(pin, "billing/direct-runtime/maxit-topup-live-cli.mjs"));
  assert.equal(await clicScript(), path.join(pin, "billing/direct-runtime/billing-cli.mjs"));
  assert.equal(fs.existsSync(events), false); checks += 3;

  // Explicit options keep precedence (tests, recettes).
  const custom = path.join(root, "custom");
  assert.equal(await maxitScript({ uiRoot: custom }), path.join(custom, "billing/direct-runtime/maxit-topup-live-cli.mjs"));
  assert.equal(await clicScript({ billingRoot: custom }), path.join(custom, "billing-cli.mjs")); checks += 2;

  // Pin missing: never refuse, load from the workspace copy and leave one alert event per adapter.
  fs.unlinkSync(pin);
  assert.equal(await maxitScript(), path.join(workspace, "billing/direct-runtime/maxit-topup-live-cli.mjs"));
  assert.equal(await clicScript(), path.join(workspace, "billing/direct-runtime/billing-cli.mjs"));
  for (const component of ["payment_maxit_topup", "payment_clictopay"]) {
    const event = JSON.parse(fs.readFileSync(path.join(events, `${component}.json`), "utf8"));
    assert.deepEqual([event.component, event.event, event.reason, event.root], [component, "fallback", "pin_missing", workspace]);
    checks += 1;
  }
  checks += 2;

  // The gate file and its value are untouched by this lot.
  const src = fs.readFileSync(path.join(__dirname, "../src/companion/maxitTopupLivePaymentAdapter.ts"), "utf8");
  assert.match(src, /const GATE_FILE="maxit-topup-live-acceptance\.enabled";/);
  assert.match(src, /const GATE_VALUE="maxit-topup-v1-live-acceptance";/); checks += 2;
  console.log(`payment adapter root: ${checks} checks passed (pin first, alerted workspace fallback, overrides kept; no execution)`);
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  console.warn = quiet; os.homedir = originalHome; fs.rmSync(root, { recursive: true, force: true });
});
