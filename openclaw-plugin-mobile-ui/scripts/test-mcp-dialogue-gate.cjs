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
  console.log(JSON.stringify({ suite: "mcp-dialogue-gate", preview: true, maintenanceRefused: true }));
  fs.rmSync(root, { recursive: true, force: true });
})().catch((error) => { console.error(error); process.exit(1); });
