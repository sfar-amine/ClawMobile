import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,24}$/;
const ACTION_ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
const STEP_ID_RE = /^[A-Za-z0-9._-]{1,24}$/;
const ARTIFACT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const TOKEN_HASH_RE = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 128 * 1024;

const SUPPORTED_PROFILES = new Set(["chat-owner-shadow", "chat-owner"]);
const CHAT_TOOLS = new Set([
  "claw_context",
  "claw_resolve",
  "claw_execute",
  "claw_status",
  "claw_artifact_read",
  "claw_exec",
]);

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function bearer(request) {
  const raw = String(request.headers.get("authorization") || "");
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeHexEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function configuredClients(env) {
  const raw = String(env.MCP_CLIENTS_JSON || "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_mcp_clients_config");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_mcp_clients_config");
  }
  return parsed;
}

export async function authenticateMcpClient(request, env) {
  const clients = configuredClients(env);
  if (!clients) return { ok: false, status: 503, error: "mcp_not_configured" };

  const token = bearer(request);
  if (!token || token.length < 24 || token.length > 512) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  const tokenHash = await sha256Hex(token);

  for (const [clientId, config] of Object.entries(clients)) {
    if (!CLIENT_ID_RE.test(clientId)) continue;
    if (!config || typeof config !== "object" || config.enabled === false) continue;
    const expected = String(config.tokenSha256 || "").toLowerCase();
    if (!TOKEN_HASH_RE.test(expected)) continue;
    if (!constantTimeHexEqual(tokenHash, expected)) continue;
    const profile = String(config.profile || "chat-owner-shadow");
    if (!SUPPORTED_PROFILES.has(profile)) {
      return { ok: false, status: 403, error: "unsupported_profile" };
    }
    return { ok: true, clientId, profile };
  }
  return { ok: false, status: 401, error: "unauthorized" };
}

function toolAllowed(profile, tool) {
  if (!SUPPORTED_PROFILES.has(profile) || !CHAT_TOOLS.has(tool)) return false;
  if (tool === "claw_exec") return profile === "chat-owner";
  return true;
}

function toolResult(value, auth) {
  const base = value && typeof value === "object" ? value : { value };
  const normalized = {
    ...base,
    _claw_access: {
      client_id: String(auth?.clientId || ""),
      profile: String(auth?.profile || ""),
      owner: auth?.profile === "chat-owner",
      read_only: auth?.profile !== "chat-owner",
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(normalized) }],
    structuredContent: normalized,
  };
}

function toolError(error) {
  const message = String(error?.message || error || "mcp_tool_failed").slice(0, 500);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ state: "failed", error: message }) }],
    structuredContent: { state: "failed", error: message },
  };
}

function stableActionRequestId(clientId, args) {
  const actionKey = String(args?.action_key || "");
  const stepKey = String(args?.step_key || "execute");
  if (!ACTION_ID_RE.test(actionKey) || !STEP_ID_RE.test(stepKey)) {
    throw new Error("invalid_action_identity");
  }
  const value = `mcp-${clientId}-${actionKey}-${stepKey}`;
  if (value.length <= 128) return value;
  throw new Error("action_identity_too_long");
}

function relayRequestId(clientId, tool, args) {
  if (tool === "claw_execute" || tool === "claw_exec") return stableActionRequestId(clientId, args);
  return `mcp:${clientId}:${crypto.randomUUID()}`;
}

function registerTools(server, auth, invoke) {
  const run = (tool) => async (args, extra) => {
    if (!toolAllowed(auth.profile, tool)) return toolError("tool_not_allowed");
    try {
      const requestId = relayRequestId(auth.clientId, tool, args);
      const value = await invoke(tool, args || {}, auth, {
        requestId,
        mcpRequestId: extra?.requestId ?? null,
      });
      return toolResult(value, auth);
    } catch (error) {
      return toolError(error);
    }
  };

  server.registerTool("claw_context", {
    title: "Claw context",
    description: "Load the canonical S24/Claw context needed for this request. Call at the start of a substantive owner session and use returned revisions/hashes for later delta calls. The returned _claw_access object is authoritative for the currently authenticated MCP profile; do not infer owner/shadow from cached client text or prior tool metadata.",
    inputSchema: {
      query: z.string().min(1).max(2000),
      after_revision: z.number().int().nonnegative().optional(),
      known_contracts: z.record(z.string(), z.string()).optional(),
      global_baseline: z.record(z.string(), z.unknown()).optional(),
      uncertain: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, run("claw_context"));

  server.registerTool("claw_resolve", {
    title: "Resolve Claw capability",
    description: "Resolve a request against the canonical Claw Capability Harness without executing it. Use only for discovery or material ambiguity; clear known requests should call claw_execute directly.",
    inputSchema: {
      request: z.string().min(1).max(12000),
      target_hint: z.string().max(128).optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, run("claw_resolve"));

  const ownerProfile = auth.profile === "chat-owner";
  server.registerTool("claw_execute", {
    title: "Execute Claw request",
    description: ownerProfile
      ? "Execute a Claw request with canonical owner authorization. Route-specific confirmations, human-only boundaries, idempotence and execution receipts still apply. Reuse action_key for retries; use a new stable step_key only for a materially new clarification/refinement step."
      : "Execute a known Claw route in shadow/read-only mode: only deterministic read routes without confirmation are admitted. Reuse action_key for retries; use a new stable step_key only for a materially new clarification/refinement step.",
    inputSchema: {
      request: z.string().min(1).max(12000),
      action_key: z.string().regex(ACTION_ID_RE),
      step_key: z.string().regex(STEP_ID_RE).optional(),
      target_hint: z.string().max(128).optional(),
    },
    annotations: { readOnlyHint: !ownerProfile, idempotentHint: true, openWorldHint: ownerProfile },
  }, run("claw_execute"));

  if (ownerProfile) {
    server.registerTool("claw_exec", {
      title: "Execute arbitrary S24 command",
      description: "Execute an arbitrary shell command directly on the S24/Termux owner runtime through the existing Claw Remote Bridge. This is a generic owner terminal primitive, not a business capability route. Reuse action_key for retries of the same command; use a new stable step_key only for a materially new command.",
      inputSchema: {
        command: z.string().min(1).max(32768),
        action_key: z.string().regex(ACTION_ID_RE),
        step_key: z.string().regex(STEP_ID_RE).optional(),
        cwd: z.string().min(1).max(4096).optional(),
        timeout_ms: z.number().int().min(100).max(300000).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    }, run("claw_exec"));
  }

  server.registerTool("claw_status", {
    title: "Read Claw execution status",
    description: "Read the canonical receipt for a previously submitted claw_execute action. This never retries or replays execution.",
    inputSchema: {
      action_key: z.string().regex(ACTION_ID_RE),
      step_key: z.string().regex(STEP_ID_RE).optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, run("claw_status"));

  server.registerTool("claw_artifact_read", {
    title: "Read Claw artifact",
    description: "Read a bounded chunk of a Claw artifact returned by an execution receipt.",
    inputSchema: {
      artifact_id: z.string().regex(ARTIFACT_ID_RE),
      source_request_id: z.string().min(1).max(128),
      offset: z.number().int().nonnegative().optional(),
      max_bytes: z.number().int().min(1).max(49152).optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, run("claw_artifact_read"));
}

export async function handleMcpHttp(request, env, invoke) {
  if (request.method !== "POST") {
    return json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405, { allow: "POST" });
  }

  let auth;
  try {
    auth = await authenticateMcpClient(request, env);
  } catch (error) {
    return json({ error: String(error?.message || error) }, 500);
  }
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status, {
      "www-authenticate": 'Bearer realm="claw-mcp"',
    });
  }

  const server = new McpServer(
    { name: "claw-mcp-gateway", version: "1.0.0" },
    { maxToolInputElements: 200 },
  );
  registerTools(server, auth, invoke);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_BODY_BYTES,
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    await transport.close();
    await server.close();
    return response;
  } catch (error) {
    try { await transport.close(); } catch {}
    try { await server.close(); } catch {}
    return json({
      jsonrpc: "2.0",
      error: { code: -32603, message: String(error?.message || "Internal server error").slice(0, 300) },
      id: null,
    }, 500);
  }
}
