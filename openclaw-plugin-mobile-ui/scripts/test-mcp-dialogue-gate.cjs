// SAM-MIG V2.2 §5.5 / §12.1: MCP keeps no server-side dialogue state. claw_resolve carries the coordinator's
// preview (single status table); during maintenance claw_execute is refused deterministically before any
// resolution, mission or bridge request (T-M01), and the action_key remains the owner's replay protection.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dialogue-gate-"));
process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR = path.join(root, ".openclaw", "remote-bridge");
process.env.CLAW_CONTINUUM_HOME = root;
process.env.CLAW_CAPABILITY_HELPER = path.join(__dirname, "fixtures", "fake-claw-capability.py");
const helper = path.join(root, "dialogue-helper.py");
const log = path.join(root, "dialogue.log");
const state = path.join(root, "lock-state");
fs.writeFileSync(helper, [
  "import base64, json, os, sys",
  "ev = json.loads(base64.b64decode(os.environ.get('CLAW_DIALOGUE_EVENT_B64', 'e30=')))",
  "open(" + JSON.stringify(log) + ", 'a').write(json.dumps({'mode': sys.argv[sys.argv.index('--dialogue') + 1], 'key': ev.get('conversationKey')}) + '\\n')",
  "closed = open(" + JSON.stringify(state) + ").read().strip() == 'closed'",
  "print(json.dumps({'outcome': 'MAINTENANCE', 'reasonCode': 'maintenance', 'text': 'Samantha est en maintenance.', 'statusTable': 'dialogue-status-table-v1'} if closed else {'outcome': 'READY', 'reasonCode': 'capability_first', 'statusTable': 'dialogue-status-table-v1', 'klass': 'FAST'}))",
  "",
].join("\n"));
process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER = helper;
const { handleMcpRelayRequest } = require("../dist/companion/mcpBridge.js");
const lines = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];

(async () => {
  fs.writeFileSync(state, "open");
  const resolved = await handleMcpRelayRequest({ requestId: "mcp:claude-chat:r1", clientId: "claude-chat", profile: "chat-owner",
    tool: "claw_resolve", arguments: { request: "mon solde orange" } });
  assert.equal(resolved.state, "resolved");
  assert.ok(resolved.result.selected, "the canonical resolution is unchanged");
  assert.deepEqual(resolved.result.dialogue, { outcome: "READY", reasonCode: "capability_first", statusTable: "dialogue-status-table-v1", klass: "FAST" });
  assert.deepEqual(lines().at(-1), { mode: "preview", key: "claude-chat" });

  fs.writeFileSync(state, "closed");
  const before = fs.existsSync(process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR) ? fs.readdirSync(process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR, { recursive: true }).length : 0;
  const refused = await handleMcpRelayRequest({ requestId: "mcp-claude-chat-maint-execute", clientId: "claude-chat", profile: "chat-owner",
    tool: "claw_execute", arguments: { request: "mon solde orange", action_key: "maint" } });
  assert.equal(refused.state, "refused");
  assert.equal(refused.reason, "maintenance");
  assert.equal(refused.retry_allowed, false);
  assert.match(refused.text, /maintenance/);
  const after = fs.existsSync(process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR) ? fs.readdirSync(process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR, { recursive: true }).length : 0;
  assert.equal(after, before, "no bridge request and no mission during maintenance");
  assert.ok(!fs.existsSync(path.join(root, ".openclaw", "continuum")) || fs.readdirSync(path.join(root, ".openclaw", "continuum")).length === 0);
  // --- Fail-closed lock read directly from the durable marker (no coordinator in the path) ---
  const dialogueHome = path.join(root, "samantha-dialogue");
  fs.mkdirSync(dialogueHome, { recursive: true });
  process.env.CLAW_DIALOGUE_HOME = dialogueHome;
  const marker = path.join(dialogueHome, "maintenance.json");
  const gateMod = require("../dist/companion/maintenanceMarker.js");
  // Same conversation reference as the Python coordinator (pinned vector, samantha-ui-playbooks model.py).
  assert.equal(gateMod.mcpConversationRef("claude-chat"), "conv-3469204b6aa6922a6b6b331d");
  // Coordinator unreachable from now on: the helper is missing.
  process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER = path.join(root, "missing-helper.py");
  let n = 0;
  const execute = () => handleMcpRelayRequest({ requestId: `mcp-claude-chat-lock-${++n}-execute`, clientId: "claude-chat", profile: "chat-owner",
    tool: "claw_execute", arguments: { request: "mon solde orange", action_key: `lock-${n}` } });
  const beforeLock = fs.existsSync(process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR) ? fs.readdirSync(process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR, { recursive: true }).length : 0;
  // 1. Marker closed + coordinator down: maintenance refusal, never "open by default".
  fs.writeFileSync(marker, JSON.stringify({ state: "closed", epoch: 3, changedAt: 1792100000000, by: "companion-deploy.sh", acceptance: [] }));
  let out = await execute();
  assert.deepEqual([out.state, out.reason, out.outcome], ["refused", "maintenance", "MAINTENANCE"]);
  // 2. Corrupted or unreadable marker: closed refusal with its reason.
  fs.writeFileSync(marker, "{not json");
  out = await execute();
  assert.deepEqual([out.state, out.reason], ["refused", "maintenance_marker_invalid"]);
  fs.writeFileSync(marker, JSON.stringify({ state: "closed", epoch: 3, changedAt: 1792100000000, acceptance: ["+21600000000"] }));
  assert.equal((await execute()).reason, "maintenance_marker_invalid");
  fs.rmSync(marker); fs.mkdirSync(marker);
  assert.equal((await execute()).reason, "maintenance_marker_unreadable");
  fs.rmSync(marker, { recursive: true });
  // 3. Marker open (or absent) + coordinator down: bounded coordinator_unavailable for an execution, no fallback.
  out = await execute();
  assert.deepEqual([out.state, out.reason, out.retry_allowed], ["failed", "coordinator_unavailable", false]);
  fs.writeFileSync(marker, JSON.stringify({ state: "open", epoch: 3, changedAt: 1792100000001, acceptance: [] }));
  assert.equal((await execute()).reason, "coordinator_unavailable");
  const afterLock = fs.existsSync(process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR) ? fs.readdirSync(process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR, { recursive: true }).length : 0;
  assert.equal(afterLock, beforeLock, "no bridge request, no mission while the lock or the coordinator refuses");
  // 4. Acceptance allowance (B-14) only for a listed MCP client; still bounded when the coordinator is down.
  fs.writeFileSync(marker, JSON.stringify({ state: "closed", epoch: 4, changedAt: 1792100000002, acceptance: [gateMod.mcpConversationRef("claude-chat")] }));
  assert.equal(gateMod.readMaintenanceGate("claude-chat").state, "acceptance");
  assert.equal(gateMod.readMaintenanceGate("other-client").state, "closed");
  assert.equal((await execute()).reason, "coordinator_unavailable");
  // 5. claw_resolve keeps its stateless preview behaviour: the resolution is still returned, with the bounded outcome.
  const diag = await handleMcpRelayRequest({ requestId: "mcp:claude-chat:r2", clientId: "claude-chat", profile: "chat-owner",
    tool: "claw_resolve", arguments: { request: "mon solde orange" } });
  assert.equal(diag.state, "resolved"); assert.ok(diag.result.selected);
  assert.equal(diag.result.dialogue.reasonCode, "coordinator_unavailable");
  // Static: the adapter only READS the marker; companion-deploy.sh stays its single writer.
  const src = fs.readFileSync(path.join(__dirname, "../src/companion/maintenanceMarker.ts"), "utf8");
  assert.doesNotMatch(src, /writeFile|appendFile|rename|unlink|rmSync|mkdir|openSync\([^)]*["']w/);
  console.log(JSON.stringify({ suite: "mcp-dialogue-gate", preview: true, maintenanceRefused: true, failClosedMarker: true,
    coordinatorUnavailableBounded: true, acceptanceAllowance: true }));
  fs.rmSync(root, { recursive: true, force: true });
})().catch((error) => { console.error(error); process.exit(1); });
