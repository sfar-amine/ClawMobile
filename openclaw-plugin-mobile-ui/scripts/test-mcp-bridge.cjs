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
process.env.CLAW_CAPABILITY_HELPER =
  process.env.CLAW_MCP_TEST_HELPER ||
  path.join(__dirname, "fixtures", "fake-claw-capability.py");
const ownerDelegate = path.join(root, "owner-delegate.py");
const ownerDelegateCount = path.join(root, "owner-delegate.count");
fs.writeFileSync(ownerDelegate, `#!/usr/bin/env python3\nimport json, os\np=os.environ.get("CLAWMOBILE_MCP_OWNER_DELEGATE_COUNT_FILE")\nif p:\n    open(p,"a").write("1\\n")\nprint(json.dumps({"ok":True,"result":{"payloads":[{"text":"delegated owner result"}]}}))\n`);
fs.chmodSync(ownerDelegate, 0o700);
process.env.CLAWMOBILE_MCP_OWNER_DELEGATE_HELPER = ownerDelegate;
process.env.CLAWMOBILE_MCP_OWNER_DELEGATE_COUNT_FILE = ownerDelegateCount;
process.env.CLAWMOBILE_MCP_OWNER_DELEGATE_AGENT = "main";

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
  assert.equal(result.state, "blocked");
  assert.equal(result.reason, "read_only_policy");

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
  assert.equal(repeated.state, "blocked");
  assert.equal(repeated.reason, "read_only_policy");

  const status = await handleMcpRelayRequest({
    requestId: "mcp:claude-chat:status-1",
    clientId: "claude-chat",
    profile: "chat-owner-shadow",
    tool: "claw_status",
    arguments: { action_key: "wifi-write" },
  });
  assert.equal(status.state, "blocked");
  assert.equal(status.reason, "read_only_policy");
  assert.equal(status.request_id, "mcp-claude-chat-wifi-write-execute");

  const ownerResult = await handleMcpRelayRequest({
    requestId: "mcp-claude-chat-wifi-write-owner-execute",
    clientId: "claude-chat",
    profile: "chat-owner",
    tool: "claw_execute",
    arguments: {
      request: "active le wifi",
      action_key: "wifi-write-owner",
    },
  });
  assert.notEqual(ownerResult.reason, "read_only_policy");
  const ownerReceiptPath = path.join(
    process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR,
    "requests",
    "mcp-claude-chat-wifi-write-owner-execute.json",
  );
  const ownerReceipt = JSON.parse(fs.readFileSync(ownerReceiptPath, "utf8"));
  assert.equal(ownerReceipt.method, "mcp_capability_execute_owner");
  assert.equal(ownerReceipt.mutationRisk, "write");
  assert.notEqual(ownerReceipt.result?.execution?.reason, "read_only_policy");

  const shadowDelegate = await handleMcpRelayRequest({
    requestId: "mcp-claude-chat-delegate-shadow-execute",
    clientId: "claude-chat",
    profile: "chat-owner-shadow",
    tool: "claw_execute",
    arguments: { request: "delegate recap", action_key: "delegate-shadow" },
  });
  assert.equal(shadowDelegate.state, "blocked");
  assert.equal(shadowDelegate.reason, "read_only_policy");
  assert.equal(fs.existsSync(ownerDelegateCount), false);

  const ownerDelegateResult = await handleMcpRelayRequest({
    requestId: "mcp-claude-chat-delegate-owner-execute",
    clientId: "claude-chat",
    profile: "chat-owner",
    tool: "claw_execute",
    arguments: { request: "delegate recap", action_key: "delegate-owner" },
  });
  assert.equal(ownerDelegateResult.state, "completed");
  assert.equal(ownerDelegateResult.result?.delegated, true);
  assert.equal(ownerDelegateResult.result?.text, "delegated owner result");
  const delegatedReceipt = JSON.parse(fs.readFileSync(path.join(
    process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR,
    "requests",
    "mcp-claude-chat-delegate-owner-execute.json",
  ), "utf8"));
  assert.equal(delegatedReceipt.method, "mcp_capability_execute_owner");
  assert.equal(delegatedReceipt.mutationRisk, "unknown");
  assert.equal(delegatedReceipt.result?.execution?.delegated, true);
  const ownerDelegateRepeat = await handleMcpRelayRequest({
    requestId: "mcp-claude-chat-delegate-owner-execute",
    clientId: "claude-chat",
    profile: "chat-owner",
    tool: "claw_execute",
    arguments: { request: "delegate recap", action_key: "delegate-owner" },
  });
  assert.equal(ownerDelegateRepeat.state, "completed");
  assert.equal(fs.readFileSync(ownerDelegateCount, "utf8").trim().split(/\n/).length, 1);

  const artifactDir = path.join(process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR, "artifacts");
  const requestDir = path.join(process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR, "requests");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(requestDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "mcp-test.json"), "ABCDEFGHIJ");
  const sourceRequestId = "mcp-claude-chat-artifact-source-execute";
  fs.writeFileSync(path.join(requestDir, sourceRequestId + ".json"), JSON.stringify({
    requestId: sourceRequestId,
    taskId: "mcp:claude-chat:artifact-source",
    stepId: "execute",
    sessionId: "external_mcp:claude-chat",
    method: "mcp_capability_execute_readonly",
    paramsHash: "fixture",
    state: "completed",
    instanceId: "fixture",
    receivedAt: Date.now(),
    completedAt: Date.now(),
    mutationRisk: "read",
    result: { artifact: { artifactId: "mcp-test.json", bytes: 10, contentType: "application/json" } },
  }));
  const artifact = await handleMcpRelayRequest({
    requestId: "mcp:claude-chat:artifact-call",
    clientId: "claude-chat",
    profile: "chat-owner-shadow",
    tool: "claw_artifact_read",
    arguments: {
      artifact_id: "mcp-test.json",
      source_request_id: sourceRequestId,
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
