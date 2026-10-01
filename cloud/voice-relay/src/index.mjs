const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TEXT_CHARS = 12000;

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

  authenticatedSockets() {
    return this.ctx.getWebSockets("device").filter((ws) => {
      try {
        return ws.deserializeAttachment()?.authenticated === true;
      } catch {
        return false;
      }
    });
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

  waitForResponse(requestId, ws, message) {
    const existing = this.pending.get(requestId);
    if (existing) return existing.promise;

    let resolvePending;
    const promise = new Promise((resolve) => {
      resolvePending = resolve;
    });
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      resolvePending({ success: false, error: "device_timeout" });
    }, 28000);

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
        ws.serializeAttachment({ authenticated: true });
        ws.send(JSON.stringify({ type: "auth_ok" }));
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
