import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VoiceRelay } from "./src/index.mjs";

const require = createRequire(import.meta.url);
const tmpRoot = process.env.TMPDIR || path.join(os.homedir(), ".cache", "tmp");
fs.mkdirSync(tmpRoot, { recursive: true });
const stateRoot = fs.mkdtempSync(path.join(tmpRoot, "claw-mcp-e2e-"));
process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR = path.join(stateRoot, "remote-bridge");
process.env.CLAW_UI_PLAYBOOKS_ROOT =
  process.env.CLAW_MCP_TEST_UI_ROOT ||
  path.join(os.homedir(), ".openclaw", "workspace", "ui-playbooks");
process.env.CLAW_CAPABILITY_HELPER =
  process.env.CLAW_MCP_TEST_HELPER ||
  path.resolve(process.cwd(), "../../installer/termux-lite/claw-capability.py");

const companionModule =
  process.env.CLAW_MCP_TEST_COMPANION_MODULE ||
  path.resolve(process.cwd(), "../../openclaw-plugin-mobile-ui/dist/companion/mcpBridge.js");
const { handleMcpRelayRequest } = require(companionModule);

const token = "local-e2e-token-" + "z".repeat(36);
const env = {
  MCP_CLIENTS_JSON: JSON.stringify({
    "claude-chat": {
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      profile: "chat-owner",
      enabled: true,
    },
  }),
};

const ctx = {
  setWebSocketAutoResponse() {},
  acceptWebSocket() {},
  getWebSockets() { return [deviceSocket]; },
};
const relay = new VoiceRelay(ctx, env);
const deviceSocket = {
  deserializeAttachment() { return { authenticated: true }; },
  send(raw) {
    const message = JSON.parse(raw);
    queueMicrotask(async () => {
      const response = await handleMcpRelayRequest(message);
      await relay.webSocketMessage(
        deviceSocket,
        JSON.stringify({ type: "response", requestId: message.requestId, response }),
      );
    });
  },
};

async function mcp(body) {
  const response = await relay.fetch(new Request("https://relay.example/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify(body),
  }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

let result = await mcp({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "local-e2e", version: "1" },
  },
});
assert.equal(result.status, 200);

result = await mcp({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: {
    name: "claw_resolve",
    arguments: { request: "mon solde orange" },
  },
});
assert.equal(result.status, 200);
assert.equal(result.body.result.structuredContent.state, "resolved");
assert.equal(result.body.result.structuredContent.result.surface, "external_mcp");

result = await mcp({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "claw_execute",
    arguments: {
      request: "active le wifi",
      action_key: "e2e-owner-write",
    },
  },
});
assert.equal(result.status, 200);
const execution = result.body.result.structuredContent;
assert.equal(execution.state, "completed");
assert.equal(execution.result.ok, true);

result = await mcp({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: {
    name: "claw_status",
    arguments: { action_key: "e2e-owner-write" },
  },
});
assert.equal(result.status, 200);
assert.equal(result.body.result.structuredContent.state, "completed");

console.log(JSON.stringify({
  ok: true,
  chain: "MCP SDK -> edge Durable Object -> outbound-device protocol -> Companion mcpBridge -> Capability Graph/Remote Bridge",
  surface: "external_mcp",
  ownerWriteAdmission: true,
  durableStatus: true,
}));
