// Regression: after a network switch the relay socket can go half-open. close() then never
// emits "close", and the Companion used to stay disconnected until it was restarted.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-relay-reconnect-"));
const tokenFile = path.join(dir, "device.token");
fs.writeFileSync(tokenFile, "test-device-token-0123456789abcdef\n");
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ url: "wss://relay.invalid/device", tokenFile }));
process.env.CLAW_VOICE_RELAY_CONFIG = path.join(dir, "config.json");
process.env.CLAW_VOICE_RELAY_CONNECT_DEADLINE_MS = "80";

const sockets = [];
class HalfOpenSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.closeCalls = 0;
    sockets.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
  send() {}
  // A half-open socket: close() moves to CLOSING but "close" is never emitted.
  close() { this.closeCalls++; this.readyState = 2; }
}
globalThis.WebSocket = HalfOpenSocket;

const mod = require("../dist/companion/voiceRelay.js");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  mod.startVoiceRelay();
  assert.equal(sockets.length, 1);

  // 1. Never opens (dead network): abandoned after the deadline, then a new socket.
  // The first reconnect is immediate (attempt 0); check before the second deadline.
  await wait(120);
  assert.equal(sockets[0].closeCalls, 1);
  assert.equal(sockets.length, 2, "reconnects after connect_timeout without a close event");
  assert.equal(mod.voiceRelayHealth().lastError, "connect_timeout");

  // 2. Opens and authenticates: connected, the deadline no longer applies.
  const live = sockets[sockets.length - 1];
  live.readyState = 1;
  live.emit("open");
  live.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  assert.equal(mod.voiceRelayHealth().connected, true);
  const count = sockets.length;
  await wait(200);
  assert.equal(sockets.length, count, "an authenticated socket is kept");

  // 3. Error on a half-open socket: dropped and replaced at once; late events are ignored.
  live.emit("error");
  live.readyState = 2;
  assert.equal(mod.voiceRelayHealth().connected, false);
  await wait(50);
  assert.equal(sockets.length, count + 1, "reconnects right after the error");
  live.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  live.emit("close");
  assert.equal(mod.voiceRelayHealth().authenticated, false, "events from the old socket are ignored");
  assert.equal(sockets.length, count + 1, "a late close does not start a second socket");

  mod.stopVoiceRelay();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("voice-relay reconnect tests: PASS");
})().catch((error) => {
  mod.stopVoiceRelay();
  console.error(error);
  process.exit(1);
});
