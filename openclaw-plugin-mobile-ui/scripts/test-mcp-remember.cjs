// M2 claw_remember: MCP owner "retiens ça" through the canonical context-event.sh writer.
// Exercises the real writer/store (copied into an isolated root, never runtime HOME),
// the Remote Bridge receipt idempotence and the S24 memory.db schema captured in c10.
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "m2-remember-"));
const installer = path.resolve(__dirname, "../../installer/termux-lite");
const scripts = path.join(root, "scripts");
fs.mkdirSync(scripts);
for (const name of fs.readdirSync(installer)) {
  if (!(/^context.*\.(sh|py)$/.test(name) || name === "bounded-log.py")) continue;
  let text = fs.readFileSync(path.join(installer, name), "utf8");
  if (name.endsWith(".sh")) text = "#!/usr/bin/env bash\n" + text.split("\n").slice(1).join("\n");
  fs.writeFileSync(path.join(scripts, name), text, { mode: 0o700 });
}
// Counting shim: proves a replay never re-dispatches the canonical writer.
const calls = path.join(root, "writer-calls.log");
const shim = path.join(root, "context-event-shim.sh");
fs.writeFileSync(shim, `#!/usr/bin/env bash\necho x >> ${JSON.stringify(calls)}\nexec bash ${JSON.stringify(path.join(scripts, "context-event.sh"))} "$@"\n`, { mode: 0o700 });
const state = path.join(root, "context-sync");
const hybrid = path.join(root, "workspace/context/HYBRID_CONTEXT.md");
fs.mkdirSync(path.dirname(hybrid), { recursive: true });
fs.writeFileSync(hybrid, "# Fixture foundation preserved\n");
process.env.SAMANTHA_CONTEXT_ROOT = state;
process.env.SAMANTHA_HYBRID_PATH = hybrid;
process.env.SAMANTHA_CONTEXT_EVENT = shim;
process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR = path.join(root, "remote-bridge");
process.env.CLAW_CONTINUUM_HOME = root;
process.env.CLAW_UI_PLAYBOOKS_ROOT = path.join(root, "no-playbooks");

const { handleMcpRelayRequest } = require("../dist/companion/mcpBridge.js");
const { submitRemoteBridgeRequest } = require("../dist/companion/remoteBridge.js");

const sql = (query, ...args) => {
  const run = cp.spawnSync("python3", ["-c", "import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\nprint(json.dumps(c.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall()))", path.join(state, "memory.db"), query, JSON.stringify(args)], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};
const writerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length : 0);
const receiptsText = () => {
  const dir = process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR;
  const out = [];
  const walk = (folder) => { if (!fs.existsSync(folder)) return; for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const full = path.join(folder, entry.name); if (entry.isDirectory()) walk(full); else out.push(fs.readFileSync(full, "utf8")); } };
  walk(dir);
  return out.join("\n");
};
const remember = (clientId, actionKey, args, profile = "chat-owner", requestId) =>
  handleMcpRelayRequest({
    requestId: requestId || `mcp-${clientId}-${actionKey}-execute`,
    clientId,
    profile,
    tool: "claw_remember",
    arguments: { action_key: actionKey, ...args },
  });

(async () => {
  try {
    // S24 memory.db schema (c10 capture, sanitized) is the store this writer feeds.
    const c10 = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/s24-2026-10-10/c10/memory-events-200.json"), "utf8"));
    assert.equal(c10._capture.sanitized, true);
    const capturedColumns = c10.schema.events.match(/\((.*)\)/s)[1].split(",").map((part) => part.trim().split(/\s+/)[0]);
    // Installed writer on the S24 (read-only capture 11/10) is byte-identical to the one exercised here.
    const m2 = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/s24-2026-10-12/m2/context-writer.json"), "utf8"));
    assert.equal(m2._capture.sanitized, true);
    // Interface parity with the installed writer (same surfaces, kinds and options), not byte identity:
    // the writer legitimately evolves (M3 telemetry refusal), the contract claw_remember relies on must not.
    const localUsage = fs.readFileSync(path.join(installer, "context-event.sh"), "utf8").match(/usage: \$0 [^"\n]*/)[0];
    assert.equal(localUsage, m2.usage, "context-event.sh interface changed");
    assert.equal(m2.memoryDb.schema, c10.schema.events);
    assert.ok(!m2.memoryDb.eventsBySurface.codex, "codex never wrote before M2");
    const capturedKinds = new Set(c10.events.map((row) => row.kind));
    for (const kind of ["decision", "learning", "constraint", "open_thread", "completed_action"]) assert.ok(capturedKinds.has(kind), kind);

    // 1. Owner Claude records a decision: canonical row, surface from identity, receipt without text.
    const text = "Décision M2 : la capture « retiens ça » passe par context-event.sh.";
    const first = await remember("claude-chat", "m2-decision-1", { text, kind: "decision", surface: "work", client_id: "codex" });
    assert.equal(first.state, "recorded", JSON.stringify(first));
    assert.match(first.event_id, /^[0-9a-f]{64}$/);
    assert.equal(first.surface, "claude");
    assert.equal(first.kind, "decision");
    assert.equal(first.request_id, "mcp-claude-chat-m2-decision-1-execute");
    assert.equal(first.retry_allowed, false);
    assert.ok(!JSON.stringify(first).includes("context-event.sh"));
    const columns = sql("SELECT name FROM pragma_table_info('events')").map((row) => row[0]);
    for (const column of capturedColumns) assert.ok(columns.includes(column), column);
    assert.deepEqual(sql("SELECT surface,kind,text FROM events WHERE id=?", first.event_id), [["claude", "decision", text]]);
    assert.ok(!receiptsText().includes("retiens ça"), "receipt must not persist remembered text");
    assert.equal(writerCalls(), 1);

    // 2. Replay with the same action_key: same receipt, no second dispatch, no new row.
    const replay = await remember("claude-chat", "m2-decision-1", { text, kind: "decision" });
    assert.deepEqual(replay, first);
    assert.equal(writerCalls(), 1);
    assert.equal(sql("SELECT COUNT(*) FROM events")[0][0], 1);
    // Same action_key with different content is a conflict, never a silent overwrite.
    await assert.rejects(remember("claude-chat", "m2-decision-1", { text: text + " Autre.", kind: "decision" }), /request_id_conflict/);
    assert.equal(writerCalls(), 1);

    // 3. claw_status reads the same receipt, never replays.
    const status = await handleMcpRelayRequest({ requestId: "mcp:claude-chat:s1", clientId: "claude-chat", profile: "chat-owner", tool: "claw_status", arguments: { action_key: "m2-decision-1" } });
    assert.equal(status.state, "recorded");
    assert.equal(status.event_id, first.event_id);
    assert.equal(writerCalls(), 1);

    // 4. Surfaces derive from the admitted client identity (closed enum of the writer).
    for (const [clientId, surface] of [["codex-cloud", "codex"], ["chatgpt-owner", "chat"], ["claude.code", "claude"]]) {
      const row = await remember(clientId, "m2-surface", { text: `Préférence ${clientId} : réponses courtes.`, kind: "constraint" });
      assert.equal(row.state, "recorded");
      assert.equal(row.surface, surface);
      assert.deepEqual(sql("SELECT surface,kind FROM events WHERE id=?", row.event_id), [[surface, "constraint"]]);
    }

    // 5. Thread lifecycle: open, then close through a superseding decision.
    const opened = await remember("codex-cloud", "m2-thread-open", { text: "Fil : qualifier claw_remember sur le S24.", kind: "open_thread" });
    const closed = await remember("codex-cloud", "m2-thread-close", { text: "Fil clos : claw_remember qualifié.", kind: "decision", supersedes: opened.event_id });
    assert.equal(closed.state, "recorded");
    assert.equal(closed.supersedes, opened.event_id);
    assert.deepEqual(sql("SELECT supersedes FROM events WHERE id=?", closed.event_id), [[opened.event_id]]);

    // 6. Secret-like text is refused by the canonical filter: nothing written, nothing echoed.
    let before = sql("SELECT COUNT(*) FROM events")[0][0];
    for (const [key, secret] of [["m2-otp", "Mon OTP Maxit est 482913"], ["m2-card", "Carte 4111 1111 1111 1111"], ["m2-bearer", "Authorization: Bearer abcdefghijklmnop"], ["m2-password", "le password du wifi est hunter2"]]) {
      const refused = await remember("claude-chat", key, { text: secret, kind: "learning" });
      assert.equal(refused.state, "refused", key);
      assert.equal(refused.reason, "secret_like_text");
      assert.equal(refused.event_id, undefined);
      assert.ok(!JSON.stringify(refused).includes(secret));
      assert.ok(!receiptsText().includes(secret.split(" ").pop()));
    }
    assert.equal(sql("SELECT COUNT(*) FROM events")[0][0], before);

    // 7. Pre-dispatch validation: no transcript, bounded text, closed kinds, owner only, stable identity.
    const dispatched = writerCalls();
    await assert.rejects(remember("claude-chat", "m2-transcript", { text: "User: retiens que je pars lundi\nAssistant: D'accord, noté.", kind: "learning" }), /remember_transcript_refused/);
    await assert.rejects(remember("claude-chat", "m2-lines", { text: Array.from({ length: 8 }, (_, i) => `ligne ${i}`).join("\n"), kind: "learning" }), /remember_transcript_refused/);
    await assert.rejects(remember("claude-chat", "m2-long", { text: "x".repeat(1001), kind: "learning" }), /invalid_remember_text/);
    await assert.rejects(remember("claude-chat", "m2-empty", { text: "   ", kind: "learning" }), /invalid_remember_text/);
    await assert.rejects(remember("claude-chat", "m2-flag", { text: "--supersedes x", kind: "learning" }), /invalid_remember_text/);
    await assert.rejects(remember("claude-chat", "m2-checkpoint", { text: "Point interne", kind: "checkpoint" }), /invalid_kind/);
    await assert.rejects(remember("claude-chat", "m2-sup", { text: "Remplacement", kind: "decision", supersedes: "nothex" }), /invalid_remember_supersedes/);
    await assert.rejects(remember("claude-chat", "m2-shadow", { text: "Fait shadow", kind: "learning" }, "chat-owner-shadow"), /owner_profile_required/);
    await assert.rejects(remember("claude-chat", "m2-id", { text: "Fait", kind: "learning" }, "chat-owner", "mcp-claude-chat-other-execute"), /action_request_id_mismatch/);
    assert.equal(writerCalls(), dispatched);
    assert.ok(fs.readFileSync(hybrid, "utf8").includes("# Fixture foundation preserved"));

    // 8. The bridge method itself refuses any caller without admitted MCP owner access.
    const direct = await submitRemoteBridgeRequest({ requestId: "direct-remember-1", method: "context_remember", params: { surface: "claude", kind: "learning", text: "Bypass" } });
    assert.equal(direct.state, "failed");
    assert.equal(direct.error, "owner_mcp_access_required");
    assert.equal(direct.mutationRisk, "write");
    assert.equal(writerCalls(), dispatched);

    // 9. Budget at realistic volume: 200 000 existing events, one capture under 5 s.
    const seed = cp.spawnSync("python3", ["-c", `import sqlite3,sys,hashlib
c=sqlite3.connect(sys.argv[1]);base=c.execute('SELECT COALESCE(MAX(revision),0) FROM events').fetchone()[0]
c.executemany('INSERT INTO events(id,surface,kind,text,created_at,ingested_at,supersedes,revision) VALUES(?,?,?,?,?,?,?,?)',((hashlib.sha256(b'seed%d'%i).hexdigest(),'work','checkpoint','Seed checkpoint %d'%i,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',None,base+1+i) for i in range(200000)))
c.commit()`, path.join(state, "memory.db")], { encoding: "utf8" });
    assert.equal(seed.status, 0, seed.stderr);
    const started = Date.now();
    const scaled = await remember("claude-chat", "m2-scale", { text: "Décision à volume réel : budget de capture tenu.", kind: "decision" });
    const elapsed = Date.now() - started;
    assert.equal(scaled.state, "recorded");
    assert.ok(elapsed < 5000, `claw_remember took ${elapsed} ms at 200k events`);
    console.log(`M2 claw_remember: canonical writer, identity surface, receipt idempotence/no replay, conflict, status, supersession, secret refusal, transcript/kind/owner guards, bridge owner gate, 200k events in ${elapsed} ms PASS`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
