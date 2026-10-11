import { handleMcpHttp } from "./mcp.mjs";

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TEXT_CHARS = 12000;
// Edge wait for one device answer. Kept under the ~30 s MCP client budget.
export const RELAY_WAIT_MS = 28000;
// Tools whose device receipt is idempotent per action_key/step_key (canonical
// remote-bridge receipt). Only these may report a pending state instead of an error.
const ACTION_TOOLS = new Set(["claw_exec", "claw_execute"]);

// Transport outcome of an action tool, before the device answered.
// device_timeout: the request was sent and the edge stopped waiting; the device
// keeps running it and writes its receipt (observed 11/10: claw_exec of 35 s
// answered device_timeout at ~28 s, receipt completed at 35 s).
// device_disconnected: the socket dropped after the send; the effect is unknown.
// Both are read back with claw_status using the same keys; never replayed here.
export function pendingActionResult(requestId, tool, args, error) {
  if (!ACTION_TOOLS.has(String(tool || ""))) return null;
  if (error !== "device_timeout" && error !== "device_disconnected") return null;
  const actionKey = String(args?.action_key || "");
  const stepKey = String(args?.step_key || "execute");
  return {
    state: error === "device_timeout" ? "running" : "indeterminate",
    request_id: requestId,
    retry_allowed: false,
    transport: error,
    status: { tool: "claw_status", action_key: actionKey, step_key: stepKey },
    message: error === "device_timeout"
      ? "Commande transmise au S24, toujours en cours. Lire claw_status avec les mêmes clés ; ne pas rejouer."
      : "Liaison coupée après l'envoi : effet inconnu. Lire claw_status avec les mêmes clés avant toute nouvelle tentative.",
  };
}

function transportError(response) {
  return response && typeof response === "object" && response.success === false
    ? String(response.error || "")
    : "";
}

export function parseBearer(request) {
  const raw = String(request.headers.get("authorization") || "");
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function normalizeVoiceRequest(value) {
  const requestId = String(value?.requestId || "").trim();
  const request = String(value?.request || "").trim();
  const conversationId = String(value?.conversationId || "").trim();
  const answer = String(value?.answer || "").trim();

  if (!ID_RE.test(requestId)) {
    throw new Error("invalid_request_id");
  }

  const isContinuation = Boolean(conversationId || answer);
  if (isContinuation) {
    if (!ID_RE.test(conversationId)) {
      throw new Error("invalid_conversation_id");
    }
    if (!answer || answer.length > MAX_TEXT_CHARS) {
      throw new Error("invalid_answer");
    }
    if (request) {
      throw new Error("ambiguous_voice_turn");
    }
    return { requestId, conversationId, answer };
  }

  if (!request || request.length > MAX_TEXT_CHARS) {
    throw new Error("invalid_request");
  }
  return { requestId, request };
}

export function voiceTurnKey(value) {
  return JSON.stringify([
    String(value?.request || ""),
    String(value?.conversationId || ""),
    String(value?.answer || ""),
  ]);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    const id = env.VOICE_RELAY.idFromName("owner");
    return env.VOICE_RELAY.get(id).fetch(request);
  },
};

export function newestAuthenticated(sockets) {
  const attachment = (ws) => {
    try {
      return ws.deserializeAttachment() || {};
    } catch {
      return {};
    }
  };
  return sockets
    .filter((ws) => attachment(ws).authenticated === true)
    .sort((a, b) => Number(attachment(b).authAt || 0) - Number(attachment(a).authAt || 0));
}

export class VoiceRelay {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.pending = new Map();
    this.recent = new Map();
    try {
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("ping", "pong"),
      );
    } catch {}
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/device") return this.acceptDevice(request);
    if (url.pathname === "/mcp") {
      return handleMcpHttp(request, this.env, (tool, args, auth, meta) =>
        this.handleMcpTool(tool, args, auth, meta),
      );
    }
    if (url.pathname === "/health") {
      if (!this.ownerAuthorized(request)) {
        return json({ error: "unauthorized" }, 401);
      }
      return json({ connected: this.authenticatedSockets().length });
    }
    if (url.pathname === "/voice" && request.method === "POST") {
      return this.handleVoice(request);
    }
    return json({ error: "not_found" }, 404);
  }

  ownerAuthorized(request) {
    const configured = String(this.env.OWNER_TOKEN || "");
    return configured.length >= 24 && parseBearer(request) === configured;
  }

  acceptDevice(request) {
    if (String(request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
      return json({ error: "websocket_required" }, 426);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["device"]);
    server.serializeAttachment({ authenticated: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Newest first: after a network switch the previous socket can stay half-open on this
  // side, and sending to it only ends in device_timeout.
  authenticatedSockets() {
    return newestAuthenticated(this.ctx.getWebSockets("device"));
  }

  cleanupRecent(now = Date.now()) {
    for (const [key, value] of this.recent) {
      if (now - value.at > 10 * 60_000) this.recent.delete(key);
    }
  }

  async handleVoice(request) {
    if (!this.ownerAuthorized(request)) {
      return json({ error: "unauthorized" }, 401);
    }

    let body;
    try {
      body = normalizeVoiceRequest(await request.json());
    } catch (error) {
      return json({ error: String(error?.message || "invalid_request") }, 400);
    }

    this.cleanupRecent();
    const turnKey = voiceTurnKey(body);
    const prior = this.recent.get(body.requestId);
    if (prior) {
      if (prior.turnKey !== turnKey) {
        return json({ error: "request_id_conflict" }, 409);
      }
      return json(prior.response, prior.response?.success === false ? 502 : 200);
    }

    const sockets = this.authenticatedSockets();
    if (!sockets.length) return json({ error: "device_offline" }, 503);

    const response = await this.waitForResponse(
      body.requestId,
      sockets[0],
      JSON.stringify({ type: "request", ...body }),
    );

    this.recent.set(body.requestId, {
      turnKey,
      response,
      at: Date.now(),
    });
    return json(response, response?.success === false ? 502 : 200);
  }

  async handleMcpTool(tool, args, auth, meta) {
    const requestId = String(meta?.requestId || "").trim();
    if (!ID_RE.test(requestId)) throw new Error("invalid_request_id");

    this.cleanupRecent();
    const turnKey = JSON.stringify([
      "mcp",
      String(auth?.clientId || ""),
      String(tool || ""),
      args || {},
    ]);
    const prior = this.recent.get(requestId);
    if (prior) {
      if (prior.turnKey !== turnKey) throw new Error("request_id_conflict");
      return prior.response;
    }

    const sockets = this.authenticatedSockets();
    if (!sockets.length) throw new Error("device_offline");
    const response = await this.waitForResponse(
      requestId,
      sockets[0],
      JSON.stringify({
        type: "mcp_request",
        requestId,
        clientId: String(auth.clientId || ""),
        profile: String(auth.profile || ""),
        tool: String(tool || ""),
        arguments: args || {},
      }),
    );
    const error = transportError(response);
    if (["device_timeout", "device_disconnected", "device_send_failed"].includes(error)) {
      // Not cached: a later call with the same keys must reach the device, whose
      // receipt answers running/completed without a second dispatch.
      return pendingActionResult(requestId, tool, args, error) || response;
    }
    this.recent.set(requestId, { turnKey, response, at: Date.now() });
    return response;
  }

  waitForResponse(requestId, ws, message, waitMs = this.waitMs || RELAY_WAIT_MS) {
    const existing = this.pending.get(requestId);
    if (existing) return existing.promise;

    let resolvePending;
    const promise = new Promise((resolve) => {
      resolvePending = resolve;
    });
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      resolvePending({ success: false, error: "device_timeout" });
    }, waitMs);

    this.pending.set(requestId, {
      promise,
      resolve: (value) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolvePending(value);
      },
    });

    try {
      ws.send(message);
    } catch {
      clearTimeout(timer);
      this.pending.delete(requestId);
      resolvePending({ success: false, error: "device_send_failed" });
    }
    return promise;
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;

    let attachment = {};
    try {
      attachment = ws.deserializeAttachment() || {};
    } catch {}

    if (!attachment.authenticated) {
      let value;
      try {
        value = JSON.parse(message);
      } catch {
        value = {};
      }
      if (
        value?.type === "auth" &&
        String(value?.token || "") === String(this.env.DEVICE_TOKEN || "") &&
        String(this.env.DEVICE_TOKEN || "").length >= 24
      ) {
        ws.serializeAttachment({ authenticated: true, authAt: Date.now() });
        ws.send(JSON.stringify({ type: "auth_ok" }));
        // One device: a fresh authentication replaces any older socket.
        for (const other of this.ctx.getWebSockets("device")) {
          if (other === ws) continue;
          try {
            other.close(1012, "replaced");
          } catch {}
        }
      } else {
        ws.close(1008, "unauthorized");
      }
      return;
    }

    let value;
    try {
      value = JSON.parse(message);
    } catch {
      return;
    }
    if (value?.type !== "response") return;

    const requestId = String(value?.requestId || "");
    const pending = this.pending.get(requestId);
    if (pending) {
      pending.resolve(
        value?.response || { success: false, error: "empty_response" },
      );
    }
  }

  async webSocketClose() {
    this.failPending("device_disconnected");
  }

  async webSocketError() {
    this.failPending("device_disconnected");
  }

  failPending(error) {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      pending.resolve({ success: false, error });
    }
  }
}
