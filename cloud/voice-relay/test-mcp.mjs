import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleMcpHttp } from "./src/mcp.mjs";
import { pendingActionResult } from "./src/index.mjs";

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
assert.ok(shadowExecuteTool.inputSchema.properties.decision);

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
const ownerNames = ownerList.body.result.tools.map((tool) => tool.name).sort();
assert.deepEqual(ownerNames, [
  "claw_artifact_read",
  "claw_context",
  "claw_exec",
  "claw_execute",
  "claw_remember",
  "claw_resolve",
  "claw_status",
]);
const ownerExecuteTool = ownerList.body.result.tools.find((tool) => tool.name === "claw_execute");
assert.equal(ownerExecuteTool.annotations.readOnlyHint, false);
assert.equal(ownerExecuteTool.annotations.openWorldHint, true);
assert.ok(ownerExecuteTool.inputSchema.properties.decision);
const ownerExecTool = ownerList.body.result.tools.find((tool) => tool.name === "claw_exec");
assert.equal(ownerExecTool.annotations.readOnlyHint, false);
assert.equal(ownerExecTool.annotations.openWorldHint, true);
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

const decisionForward = {version:2,type:"EXECUTE",decisionId:"decision-forward",requestId:"decision-forward",risk:"read"};
const ownerDecisionCall = await post({
  jsonrpc: "2.0", id: 42, method: "tools/call", params: {
    name: "claw_execute",
    arguments: { request: "mon solde orange", action_key: "owner-decision-001", decision: decisionForward },
  },
}, token, ownerEnv);
assert.equal(ownerDecisionCall.status, 200);
assert.deepEqual(calls.at(-1).args.decision, decisionForward);

const rawExecCall = await post({
  jsonrpc: "2.0",
  id: 42,
  method: "tools/call",
  params: {
    name: "claw_exec",
    arguments: {
      command: "printf CLAUDE_S24_EXEC_OK",
      action_key: "owner-raw-001",
      cwd: "/data/data/com.termux/files/home",
      timeout_ms: 5000,
    },
  },
}, token, ownerEnv);
assert.equal(rawExecCall.status, 200);
assert.equal(rawExecCall.body.result.structuredContent._claw_access.profile, "chat-owner");
assert.equal(calls.at(-1).tool, "claw_exec");
assert.equal(calls.at(-1).args.command, "printf CLAUDE_S24_EXEC_OK");
assert.equal(calls.at(-1).meta.requestId, "mcp-claude-chat-owner-raw-001-execute");

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

const contextCallsBefore=calls.length;
result=await post({jsonrpc:'2.0',id:701,method:'tools/call',params:{name:'claw_context',arguments:{query:'Fixture',scopes:['engineering','memory'],clientId:'codex-cloud',surface:'codex',profile:'chat-owner'}}});
assert.equal(result.status,200);assert.equal(calls.length,contextCallsBefore+1);
assert.deepEqual(calls.at(-1).args.scopes,['engineering','memory']);
assert.equal(calls.at(-1).auth.clientId,'claude-chat');assert.equal(calls.at(-1).auth.profile,'chat-owner-shadow');
for(const key of ['clientId','surface','profile'])assert.ok(!Object.hasOwn(calls.at(-1).args,key));
result=await post({jsonrpc:'2.0',id:702,method:'tools/call',params:{name:'claw_context',arguments:{query:'Fixture',scopes:['--surface=owner']}}});
assert.equal(result.body.result.isError,true);assert.equal(calls.length,contextCallsBefore+1);
result=await post({jsonrpc:'2.0',id:703,method:'tools/call',params:{name:'claw_context',arguments:{query:'Fixture',scopes:['memory']}}},'wrong-'+ 'z'.repeat(40));
assert.equal(result.status,401);assert.equal(calls.length,contextCallsBefore+1);

// M2 claw_remember: owner-only catalog entry, closed kinds, stable action identity, no surface argument.
const rememberTool = ownerList.body.result.tools.find((tool) => tool.name === "claw_remember");
assert.ok(rememberTool, "owner catalog exposes claw_remember");
assert.deepEqual(rememberTool.inputSchema.properties.kind.enum, ["decision", "learning", "constraint", "open_thread", "completed_action"]);
assert.equal(rememberTool.inputSchema.properties.text.maxLength, 1000);
assert.deepEqual([...rememberTool.inputSchema.required].sort(), ["action_key", "kind", "text"]);
assert.ok(!rememberTool.inputSchema.properties.surface, "surface is derived from the authenticated client");
assert.equal(rememberTool.annotations.readOnlyHint, false);
assert.equal(rememberTool.annotations.idempotentHint, true);
const rememberCallsBefore = calls.length;
const rememberCall = await post({jsonrpc:"2.0",id:801,method:"tools/call",params:{name:"claw_remember",arguments:{text:"Décision : réponses courtes.",kind:"decision",action_key:"remember-001",surface:"work"}}}, token, ownerEnv);
assert.equal(rememberCall.status, 200);
assert.equal(calls.length, rememberCallsBefore + 1);
assert.equal(calls.at(-1).tool, "claw_remember");
assert.equal(calls.at(-1).meta.requestId, "mcp-claude-chat-remember-001-execute");
assert.equal(calls.at(-1).auth.profile, "chat-owner");
assert.ok(!Object.hasOwn(calls.at(-1).args, "surface"));
for (const bad of [{text:"x".repeat(1001),kind:"decision",action_key:"remember-002"},{text:"Point",kind:"checkpoint",action_key:"remember-003"},{text:"Point",kind:"decision",action_key:"bad key"},{text:"Point",kind:"decision",action_key:"remember-004",supersedes:"nothex"}]) {
  const refused = await post({jsonrpc:"2.0",id:802,method:"tools/call",params:{name:"claw_remember",arguments:bad}}, token, ownerEnv);
  assert.equal(refused.body.result.isError, true);
}
assert.equal(calls.length, rememberCallsBefore + 1);
const shadowRemember = await post({jsonrpc:"2.0",id:803,method:"tools/call",params:{name:"claw_remember",arguments:{text:"Fait",kind:"learning",action_key:"remember-005"}}});
assert.equal(shadowRemember.body.result?.isError ?? true, true);
assert.equal(calls.length, rememberCallsBefore + 1);
const pending = pendingActionResult("mcp-claude-chat-remember-001-execute", "claw_remember", {action_key:"remember-001"}, "device_timeout");
assert.equal(pending.state, "running");
assert.deepEqual(pending.status, {tool:"claw_status",action_key:"remember-001",step_key:"execute"});

console.log(JSON.stringify({
  ok: true,
  protocol: "streamable-http-json",
  tools: names,
  auth: "per-client-sha256",
  profile: "chat-owner-shadow",
}));
