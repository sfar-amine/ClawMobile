// Bridge long (fichier 41, piste 3) : une commande claw_exec plus longue que l'attente
// de l'edge renvoie un état `running` lisible par claw_status, n'est pas mise en cache
// comme erreur, et un appel suivant avec les mêmes clés atteint le reçu du S24 sans
// second dispatch côté edge.
import assert from "node:assert/strict";
import { VoiceRelay, RELAY_WAIT_MS, pendingActionResult } from "./src/index.mjs";

assert.equal(RELAY_WAIT_MS, 28000, "l'attente edge reste sous le budget client ~30 s");

function fakeSocket() {
  const sent = [];
  return {
    sent,
    deserializeAttachment: () => ({ authenticated: true, authAt: 1 }),
    send(message) { sent.push(JSON.parse(message)); },
    close() {},
  };
}

function relayWith(ws, waitMs = 30) {
  const ctx = { getWebSockets: () => [ws], acceptWebSocket() {} };
  const relay = new VoiceRelay(ctx, {});
  relay.waitMs = waitMs;
  return relay;
}

const auth = { clientId: "claude-chat", profile: "chat-owner" };
const args = { command: "sleep 35", action_key: "rel41-bridge-long-demo", step_key: "sleep35", timeout_ms: 60000 };
const requestId = "mcp-claude-chat-rel41-bridge-long-demo-sleep35";

// 1. Le S24 ne répond pas avant la fin de l'attente : état running, pas d'erreur.
{
  const ws = fakeSocket();
  const relay = relayWith(ws);
  const first = await relay.handleMcpTool("claw_exec", args, auth, { requestId });
  assert.equal(first.state, "running");
  assert.equal(first.transport, "device_timeout");
  assert.equal(first.retry_allowed, false);
  assert.deepEqual(first.status, { tool: "claw_status", action_key: args.action_key, step_key: args.step_key });
  assert.equal(first.success, undefined, "plus de success:false");
  assert.equal(ws.sent.length, 1);
  assert.equal(relay.recent.has(requestId), false, "un état de transport n'est jamais mis en cache");

  // 2. Même clés après la fin côté S24 : la requête atteint l'appareil, qui répond par
  // son reçu existant (aucun second effet : dédoublonnage du reçu remote-bridge).
  const second = relay.handleMcpTool("claw_exec", args, auth, { requestId });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ws.sent.length, 2);
  assert.equal(ws.sent[1].requestId, requestId, "même requestId stable : le reçu S24 fait foi");
  const receipt = { request_id: requestId, state: "completed", retry_allowed: false, result: { exitCode: 0, durationMs: 35140 } };
  await relay.webSocketMessage(ws, JSON.stringify({ type: "response", requestId, response: receipt }));
  assert.deepEqual(await second, receipt);

  // 3. Le résultat terminal est alors mis en cache : pas de nouvel envoi.
  const third = await relay.handleMcpTool("claw_exec", args, auth, { requestId });
  assert.deepEqual(third, receipt);
  assert.equal(ws.sent.length, 2);
}

// 4. Liaison coupée après l'envoi : effet inconnu, jamais « échec » rejouable.
{
  const ws = fakeSocket();
  const relay = relayWith(ws, 5000);
  const pending = relay.handleMcpTool("claw_exec", args, auth, { requestId });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await relay.webSocketClose();
  const result = await pending;
  assert.equal(result.state, "indeterminate");
  assert.equal(result.transport, "device_disconnected");
  assert.equal(relay.recent.has(requestId), false);
}

// 5. Outils de lecture et voix : comportement inchangé (erreur explicite).
{
  const ws = fakeSocket();
  const relay = relayWith(ws);
  const value = await relay.handleMcpTool("claw_context", { query: "x" }, auth, { requestId: "mcp:claude-chat:abc" });
  assert.deepEqual(value, { success: false, error: "device_timeout" });
  assert.equal(pendingActionResult("v1", "voice", {}, "device_timeout"), null);
  assert.equal(pendingActionResult(requestId, "claw_exec", args, "device_send_failed"), null);
}

// 6. claw_execute suit la même règle (reçu idempotent par action_key/step_key).
{
  const ws = fakeSocket();
  const relay = relayWith(ws);
  const value = await relay.handleMcpTool("claw_execute", { request: "x", action_key: "rel41-k" }, auth, { requestId: "mcp-claude-chat-rel41-k-execute" });
  assert.equal(value.state, "running");
  assert.equal(value.status.step_key, "execute");
}

console.log(JSON.stringify({ ok: true, test: "edge-long-action-running" }));
