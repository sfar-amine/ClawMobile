import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Transport delivery only. Remote Bridge remains the execution/idempotency owner.
export class SlackJournal {
  constructor(root, { limit = 128, retentionMs = 86400000, now = Date.now } = {}) {
    this.root = root; this.limit = limit; this.retentionMs = retentionMs; this.now = now;
    this.rows = new Map();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(root)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const row = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
      if (row.key + ".json" !== name) throw new Error("journal_corrupt");
      this.rows.set(row.key, row);
    }
    this.prune();
  }
  key(channel, ts) { return createHash("sha256").update(channel + ":" + ts).digest("hex"); }
  get(channel, ts) { return this.rows.get(this.key(channel, ts)); }
  save(row) {
    const file = path.join(this.root, row.key + ".json"), temp = file + ".tmp";
    const fd = fs.openSync(temp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(row)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    const dir = fs.openSync(this.root, "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    this.rows.set(row.key, row);
    return row;
  }
  add(event, request, text = null) {
    const existing = this.get(event.channel, event.ts);
    if (existing) return existing;
    this.prune();
    if ([...this.rows.values()].filter(r => r.state !== "delivered").length >= this.limit) {
      throw new Error("transport_queue_full");
    }
    return this.save({ key: this.key(event.channel, event.ts), channel: event.channel,
      ts: event.ts, threadTs: event.thread_ts || event.ts, user: event.user,
      request, text, state: text === null ? "received" : "reply_pending",
      createdAt: this.now(), attempts: 0, nextAt: 0 });
  }
  update(row, changes) { return this.save({ ...row, ...changes }); }
  delivered(row, slackTs) {
    // Drop private command/output payloads after delivery; retain dedup metadata.
    const { request, text, ...metadata } = row;
    return this.save({ ...metadata, requestId: request?.requestId || row.requestId,
      state: "delivered", deliveredAt: this.now(), slackTs });
  }
  prune() {
    const done = [...this.rows.values()].filter(r => r.state === "delivered")
      .sort((a, b) => b.deliveredAt - a.deliveredAt);
    for (let i = 0; i < done.length; i++) {
      const row = done[i];
      if (i < 1024 && this.now() - row.deliveredAt <= this.retentionMs) continue;
      fs.unlinkSync(path.join(this.root, row.key + ".json")); this.rows.delete(row.key);
    }
  }
  stats() {
    const pending = [...this.rows.values()].filter(r => r.state !== "delivered");
    return { pending: pending.length,
      attention: pending.filter(r => r.state === "attention_required").length,
      oldestPendingAgeMs: pending.length ? this.now() - Math.min(...pending.map(r => r.createdAt)) : 0 };
  }
}

export async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const value = await response.json();
    return { response, value };
  } finally { clearTimeout(timer); }
}
