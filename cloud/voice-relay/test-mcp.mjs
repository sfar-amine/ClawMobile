import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleMcpHttp } from "./src/mcp.mjs";

const token = "test-token-" + "x".repeat(40);
const tokenSha256 = createHash("sha256").update(token).digest("hex");
const env = {
  MCP_CLIENTS_JSON: JSON.stringify({
    "claude-chat": {
      tokenSha256,
      profile: "chat-owner-shadow",
      enabled: true,
    },
  }),
};
const calls = [];

async function invoke(tool, args, auth, meta) {
  calls.push({ tool, args, auth, meta });
  return { state: "ok", tool, client: auth.clientId, args };
}

async function post(body, authToken = token, targetEnv = env) {
  const response = await handleMcpHttp(
    new Request("https://claw.example/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify(body),
    }),
    targetEnv,
    invoke,
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

let result = await post({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "claw-test", version: "1.0.0" },
  },
});
assert.equal(result.status, 200);
assert.equal(result.body.result.serverInfo.name, "claw-mcp-gateway");

result = await post({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
});
assert.equal(result.status, 200);
const names = result.body.result.tools.map((tool) => tool.name).sort();
assert.deepEqual(names, [
  "claw_artifact_read",
  "claw_context",
  "claw_execute",
  "claw_resolve",
  "claw_status",
]);
const shadowExecuteTool = result.body.result.tools.find((tool) => tool.name === "claw_execute");
assert.equal(shadowExecuteTool.annotations.readOnlyHint, true);
assert.equal(shadowExecuteTool.annotations.openWorldHint, false);

result = await post({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "claw_resolve",
    arguments: { request: "mon solde orange" },
  },
});
assert.equal(result.status, 200);
assert.equal(result.body.result.structuredContent.state, "ok");
assert.equal(result.body.result.structuredContent._claw_access.profile, "chat-owner-shadow");
assert.equal(result.body.result.structuredContent._claw_access.owner, false);
assert.equal(result.body.result.structuredContent._claw_access.read_only, true);
assert.equal(calls.at(-1).tool, "claw_resolve");
assert.equal(calls.at(-1).auth.clientId, "claude-chat");

result = await post({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: {
    name: "claw_execute",
    arguments: {
      request: "mon solde orange",
      action_key: "balance-001",
    },
  },
});
assert.equal(result.status, 200);
assert.equal(calls.at(-1).meta.requestId, "mcp-claude-chat-balance-001-execute");
assert.equal(calls.at(-1).auth.profile, "chat-owner-shadow");

const ownerEnv = {
  MCP_CLIENTS_JSON: JSON.stringify({
    "claude-chat": { tokenSha256, profile: "chat-owner", enabled: true },
  }),
};
const ownerList = await post({
  jsonrpc: "2.0",
  id: 40,
  method: "tools/list",
  params: {},
}, token, ownerEnv);
assert.equal(ownerList.status, 200);
const ownerExecuteTool = ownerList.body.result.tools.find((tool) => tool.name === "claw_execute");
assert.equal(ownerExecuteTool.annotations.readOnlyHint, false);
assert.equal(ownerExecuteTool.annotations.openWorldHint, true);
const ownerCall = await post({
  jsonrpc: "2.0",
  id: 41,
  method: "tools/call",
  params: {
    name: "claw_execute",
    arguments: { request: "active le wifi", action_key: "owner-write-001" },
  },
}, token, ownerEnv);
assert.equal(ownerCall.status, 200);
assert.equal(ownerCall.body.result.structuredContent._claw_access.profile, "chat-owner");
assert.equal(ownerCall.body.result.structuredContent._claw_access.owner, true);
assert.equal(ownerCall.body.result.structuredContent._claw_access.read_only, false);
assert.equal(calls.at(-1).auth.profile, "chat-owner");
assert.equal(calls.at(-1).meta.requestId, "mcp-claude-chat-owner-write-001-execute");

result = await post({
  jsonrpc: "2.0",
  id: 5,
  method: "tools/call",
  params: {
    name: "claw_execute",
    arguments: {
      request: "mon solde orange",
      action_key: "bad key",
    },
  },
});
assert.equal(result.status, 200);
assert.equal(result.body.result.isError, true);

result = await post(
  {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/list",
    params: {},
  },
  "wrong-" + "y".repeat(40),
);
assert.equal(result.status, 401);

const getResponse = await handleMcpHttp(
  new Request("https://claw.example/mcp", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  }),
  env,
  invoke,
);
assert.equal(getResponse.status, 405);

const unconfigured = await handleMcpHttp(
  new Request("https://claw.example/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: "{}",
  }),
  {},
  invoke,
);
assert.equal(unconfigured.status, 503);

console.log(JSON.stringify({
  ok: true,
  protocol: "streamable-http-json",
  tools: names,
  auth: "per-client-sha256",
  profile: "chat-owner-shadow",
}));
