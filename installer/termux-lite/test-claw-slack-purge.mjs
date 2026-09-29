#!/data/data/com.termux/files/home/.openclaw-android/bin/node
import assert from "assert";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { parseRpcRequestId, isReceiptPurgeable, isOlderThan } from "./claw-slack-purge.mjs";

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || path.join(os.homedir(), ".cache", "tmp"), "claw-slack-purge-"));
const stateDir = path.join(tmp, "slack");
const receiptDir = path.join(tmp, "requests");
const healthDir = path.join(tmp, "health");
fs.mkdirSync(path.join(stateDir, "secrets"), { recursive: true });
fs.mkdirSync(receiptDir, { recursive: true });
fs.mkdirSync(healthDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "secrets", "bot-token"), "xoxb-test");
fs.writeFileSync(path.join(stateDir, "secrets", "user-token"), "xoxp-test");
fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
  channelId: "CTEST",
  botTokenFile: path.join(stateDir, "secrets", "bot-token"),
  userTokenFile: path.join(stateDir, "secrets", "user-token")
}));

const now = 2000000000;
const old = String(now - 90000);
const oldHuman = String(now - 91000);
const recent = String(now - 23 * 3600);
const rpc = (id) => "CLAW_RPC_V1\n" + JSON.stringify({ requestId: id, method: "ping", params: {} });
fs.writeFileSync(path.join(receiptDir, "done.json"), JSON.stringify({ requestId: "done", state: "completed" }));
fs.writeFileSync(path.join(receiptDir, "running.json"), JSON.stringify({ requestId: "running", state: "running" }));
fs.writeFileSync(path.join(receiptDir, "human-thread.json"), JSON.stringify({ requestId: "human-thread", state: "completed" }));

assert.equal(parseRpcRequestId(rpc("abc")), "abc");
assert.equal(parseRpcRequestId("hello"), "");
assert.equal(isReceiptPurgeable({ state: "completed" }), true);
assert.equal(isReceiptPurgeable({ state: "running" }), false);
assert.equal(isReceiptPurgeable({ state: "indeterminate" }), false);
assert.equal(isOlderThan(old, now - 86400), true);
assert.equal(isOlderThan(recent, now - 86400), false);

let deletes = [];
let deletePass = 0;
let apiDown = false;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const contentType = String(req.headers["content-type"] || "");
    let body = {};
    if (raw) {
      if (contentType.includes("application/x-www-form-urlencoded")) {
        body = Object.fromEntries(new URLSearchParams(raw));
      } else {
        body = JSON.parse(raw);
      }
    }
    const method = (req.url || "").split("/").pop();
    const reply = (value, status = 200) => {
      const text = JSON.stringify(value);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    if (apiDown) return reply({ ok: false, error: "service_unavailable" }, 503);
    if (method === "auth.test") return reply({ ok: true, user_id: "UBOT" });
    if (method === "conversations.history") {
      return reply({ ok: true, messages: [
        { ts: old, user: "UOWNER", text: rpc("done"), reply_count: 1 },
        { ts: old, user: "UOWNER", text: rpc("running"), reply_count: 0 },
        { ts: oldHuman, user: "UOWNER", text: rpc("human-thread"), reply_count: 1 },
        { ts: String(Number(old) - 2), user: "UOWNER", text: "human note" },
      ], response_metadata: { next_cursor: "" } });
    }
    if (method === "conversations.replies") {
      if (body.ts === old) {
        return reply({ ok: true, messages: [
          { ts: old, user: "UOWNER", text: rpc("done") },
          { ts: String(Number(old) + 1), user: "UBOT", bot_id: "BTEST", text: "CLAW_RPC_RESULT_V1 request=done state=completed" },
        ], response_metadata: { next_cursor: "" } });
      }
      if (body.ts === oldHuman) {
        return reply({ ok: true, messages: [
          { ts: oldHuman, user: "UOWNER", text: rpc("human-thread") },
          { ts: String(Number(oldHuman) + 1), user: "UOTHER", text: "human reply" },
        ], response_metadata: { next_cursor: "" } });
      }
      return reply({ ok: true, messages: [], response_metadata: { next_cursor: "" } });
    }
    if (method === "chat.delete") {
      deletes.push({ token: req.headers.authorization, ts: body.ts });
      if (deletePass > 0) return reply({ ok: false, error: "message_not_found" });
      return reply({ ok: true, channel: body.channel, ts: body.ts });
    }
    reply({ ok: false, error: "unknown_method" }, 404);
  });
});

await new Promise((resolve) => server.listen(18992, "127.0.0.1", resolve));

async function runOnce() {
  return await new Promise((resolve, reject) => {
    const child = spawn(path.join(os.homedir(), ".openclaw-android", "bin", "node"), [
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "claw-slack-purge.mjs"),
      "--ttl-seconds", "86400",
      "--now-seconds", String(now),
    ], {
      env: {
        ...process.env,
        CLAW_SLACK_API_BASE: "http://127.0.0.1:18992",
        CLAW_SLACK_STATE_DIR: stateDir,
        CLAW_REMOTE_BRIDGE_REQUEST_DIR: receiptDir,
        CLAW_SLACK_PURGE_LOG: path.join(healthDir, "purge.log"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(err || "exit " + code));
      else resolve(out);
    });
  });
}

const first = await runOnce();
assert.match(first, /eligible=1/);
assert.match(first, /parents_deleted=1/);
assert.match(first, /replies_deleted=1/);
assert.match(first, /skipped_active=1/);
assert.match(first, /skipped_foreign=2/);
assert.ok(!deletes.some((x) => x.ts === oldHuman));
assert.ok(deletes.some((x) => x.token === "Bearer xoxb-test"));
assert.ok(deletes.some((x) => x.token === "Bearer xoxp-test"));

deletePass = 1;
const second = await runOnce();
assert.match(second, /failed=0/);
assert.match(second, /parents_deleted=1/);
assert.match(second, /replies_deleted=1/);

fs.unlinkSync(path.join(stateDir, "secrets", "user-token"));
const third = await runOnce();
assert.match(third, /failed=0/);
assert.match(third, /skipped_no_user_token=2/);
assert.match(third, /parents_deleted=0/);

apiDown = true;
const deletesBeforeDown = deletes.length;
let downFailed = false;
try {
  await runOnce();
} catch (error) {
  downFailed = /service_unavailable/.test(String(error.message));
}
assert.equal(downFailed, true);
assert.equal(deletes.length, deletesBeforeDown);

await new Promise((resolve) => server.close(resolve));
console.log("slack-purge-tests: PASS");
