const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = process.env.TMPDIR || path.join(os.homedir(), ".cache", "tmp");
fs.mkdirSync(tmpRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tmpRoot, "claw-mcp-bridge-test-"));
process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR = path.join(root, "remote-bridge");
process.env.CLAW_UI_PLAYBOOKS_ROOT =
  process.env.CLAW_MCP_TEST_UI_ROOT ||
  path.join(os.homedir(), ".openclaw", "worktrees", "claw-mcp-gateway-ui-20261005");

const { handleMcpRelayRequest } = require("../dist/companion/mcpBridge.js");

async function main() {
  let result = await handleMcpRelayRequest({
    requestId: "mcp:claude-chat:resolve-1",
    clientId: "claude-chat",
    profile: "chat-owner-shadow",
    tool: "claw_resolve",
    arguments: { request: "mon solde orange" },
  });
  assert.equal(result.state, "resolved");
  assert.equal(result.result.surface, "external_mcp");
  assert.equal(result.result.caller, "owner");
  assert.ok(result.result.selected);

  result = await handleMcpRelayRequest({
    requestId: "mcp-claude-chat-wifi-write-execute",
    clientId: "claude-chat",
    profile: "chat-owner-shadow",
    tool: "claw_execute",
    arguments: {
      request: "active le wifi",
      action_key: "wifi-write",
    },
  });
  assert.equal(result.state, "completed");
  assert.equal(result.mutation_risk, "read");
  assert.equal(result.result.state, "blocked");
  assert.equal(result.result.reason, "mcp_shadow_read_only");

  const repeated = await handleMcpRelayRequest({
    requestId: "mcp-claude-chat-wifi-write-execute",
    clientId: "claude-chat",
    profile: "chat-owner-shadow",
    tool: "claw_execute",
    arguments: {
      request: "active le wifi",
      action_key: "wifi-write",
    },
  });
  assert.equal(repeated.request_id, result.request_id);
  assert.deepEqual(repeated.result, result.result);

  const status = await handleMcpRelayRequest({
    requestId: "mcp:claude-chat:status-1",
    clientId: "claude-chat",
    profile: "chat-owner-shadow",
    tool: "claw_status",
    arguments: { action_key: "wifi-write" },
  });
  assert.equal(status.state, "completed");
  assert.equal(status.request_id, "mcp-claude-chat-wifi-write-execute");

  const artifactDir = path.join(process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR, "artifacts");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "mcp-test.json"), "ABCDEFGHIJ");
  const artifact = await handleMcpRelayRequest({
    requestId: "mcp:claude-chat:artifact-call",
    clientId: "claude-chat",
    profile: "chat-owner-shadow",
    tool: "claw_artifact_read",
    arguments: {
      artifact_id: "mcp-test.json",
      offset: 2,
      max_bytes: 4,
    },
  });
  assert.equal(artifact.state, "completed");
  assert.equal(artifact.result.text, "CDEF");

  const context = await handleMcpRelayRequest({
    requestId: "mcp:claude-chat:context-1",
    clientId: "claude-chat",
    profile: "chat-owner-shadow",
    tool: "claw_context",
    arguments: {
      query: "MCP gateway bounded context smoke test",
    },
  });
  assert.equal(context.state, "context");
  assert.ok(context.bundle.readiness);
  assert.ok(Array.isArray(context.required_reads));

  const denied = await handleMcpRelayRequest({
    requestId: "mcp:claude-chat:denied",
    clientId: "claude-chat",
    profile: "engineering-owner",
    tool: "claw_resolve",
    arguments: { request: "mon solde orange" },
  });
  assert.equal(denied.state, "failed");
  assert.equal(denied.error, "unsupported_profile");

  console.log(JSON.stringify({
    ok: true,
    surface: "external_mcp",
    shadowWriteBlocked: true,
    durableReceipt: true,
    statusRead: true,
    artifactRead: true,
    contextBundle: true,
  }));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
