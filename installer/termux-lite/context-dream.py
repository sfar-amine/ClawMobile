#!/data/data/com.termux/files/usr/bin/python3
"""Incremental, source-grounded proposals in the existing shadow curator."""
from contextlib import closing
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import uuid

from context_memory import ACTIVE, COLUMNS, event, excerpt, normalized

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("context_store", HERE / "context-store.py")
store = importlib.util.module_from_spec(spec); spec.loader.exec_module(store)
IMPROVEMENT_PREFIX = "IMPROVEMENT_CANDIDATE_V1:"


def parse_improvement(text):
    if not text.startswith(IMPROVEMENT_PREFIX):
        return None
    value = json.loads(text[len(IMPROVEMENT_PREFIX):].strip())
    if not isinstance(value, dict):
        raise ValueError("candidate_payload_must_be_object")
    required = ("target", "intent", "type", "current_state", "proposed_state")
    if any(key not in value for key in required):
        raise ValueError("candidate_payload_missing_required_field")
    if not isinstance(value["target"], str) or not value["target"].strip():
        raise ValueError("candidate_target_required")
    if not isinstance(value["intent"], str) or not value["intent"].strip():
        raise ValueError("candidate_intent_required")
    if not isinstance(value["current_state"], dict) or not isinstance(value["proposed_state"], dict):
        raise ValueError("candidate_states_required")
    return value


def main():
    started = datetime.datetime.now(datetime.timezone.utc)
    run_id = started.strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    with closing(store.connect()) as conn:
        store.migrate(conn)
        conn.execute("CREATE TABLE IF NOT EXISTS curator_fingerprints(event_id TEXT PRIMARY KEY,kind TEXT NOT NULL,norm_hash TEXT NOT NULL)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_curator_norm ON curator_fingerprints(kind,norm_hash)")
        cursor = conn.execute("SELECT value FROM memory_meta WHERE key='curator_revision_v1'").fetchone()
        after = int(cursor[0]) if cursor else 0
        limit = max(1, min(int(os.environ.get("SAMANTHA_CURATOR_BATCH", "2000")), 5000))
        conn.execute("BEGIN IMMEDIATE")
        try:
            head = conn.execute("SELECT COALESCE(MAX(revision),0) FROM events").fetchone()[0]
            rows = [event(r) for r in conn.execute(f"SELECT {COLUMNS} FROM events e WHERE revision>? AND revision<=? ORDER BY revision LIMIT ?", (after, head, limit))]
            proposals = []; invalid = []; improvement_events = 0

            def propose(action, ids, payload):
                ids = sorted(set(ids))
                canonical = json.dumps({"action": action, "source_ids": ids, "payload": payload}, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
                pid = hashlib.sha256(canonical.encode()).hexdigest()
                conn.execute("INSERT OR IGNORE INTO dream_proposals(proposal_id,run_id,action,source_ids,payload,status,created_at) VALUES(?,?,?,?,?,'proposed',?)",
                             (pid, run_id, action, json.dumps(ids), json.dumps(payload, ensure_ascii=False), started.isoformat()))
                if conn.execute("SELECT changes()").fetchone()[0]:
                    proposals.append({"proposalId": pid, "action": action, "sourceCount": len(ids)})

            affected = set()
            for row in rows:
                key = hashlib.sha256(normalized(row["text"]).encode()).hexdigest()
                conn.execute("INSERT OR IGNORE INTO curator_fingerprints(event_id,kind,norm_hash) VALUES(?,?,?)", (row["id"], row["kind"], key))
                affected.add((row["kind"], key))
                if row["supersedes"]:
                    propose("confirm_supersession", [row["supersedes"], row["id"]], {"superseded": row["supersedes"], "replacement": row["id"]})
                if row["kind"] != "learning" or not row["text"].startswith(IMPROVEMENT_PREFIX):
                    continue
                if conn.execute("SELECT 1 FROM events WHERE supersedes=? LIMIT 1", (row["id"],)).fetchone():
                    continue
                try:
                    payload = parse_improvement(row["text"])
                    payload.setdefault("origin_class", "cross_surface:" + row["surface"])
                    confidence = str(payload.get("confidence") or "provisional").lower()
                    payload.setdefault("trust", {"stable": "authoritative", "validated": "verified"}.get(confidence, "provisional"))
                    propose("improvement_candidate", [row["id"]], payload)
                    improvement_events += 1
                except Exception as exc:
                    invalid.append({"sourceId": row["id"], "error": str(exc)})

            for kind, key in sorted(affected):
                group = conn.execute(f"SELECT {COLUMNS} FROM curator_fingerprints f JOIN events e ON e.id=f.event_id WHERE f.kind=? AND f.norm_hash=? AND {ACTIVE} ORDER BY e.revision", (kind, key)).fetchall()
                if len(group) > 1:
                    propose("consolidate_duplicate", [r[0] for r in group],
                            {"kind": kind, "normalizedText": normalized(group[0][4])})

            # Extractive digest: evidence pointers, source type and full hashes
            # survive. It is never injected as a new fact or used as authority.
            # No lexical guess can close a thread, revoke a constraint or promote a route.
            active_rows = [row for row in rows if not conn.execute("SELECT 1 FROM events WHERE supersedes=? LIMIT 1", (row["id"],)).fetchone()]
            for offset in range(0, len(active_rows), 24):
                batch = active_rows[offset:offset + 24]
                items = []
                for row in batch:
                    text, truncated = excerpt(row["text"], 160)
                    items.append({"revision": row["revision"], "kind": row["kind"], "surface": row["surface"],
                                  "observed_at": row["createdAt"], "supersedes": row["supersedes"],
                                  "source_sha256": hashlib.sha256(row["text"].encode()).hexdigest(),
                                  "excerpt": text, "truncated": truncated})
                propose("memory_digest", [row["id"] for row in batch],
                        {"mode": "extractive_review_only", "authority": "source_required",
                         "instruction": "Read full cited events before applying any semantic change. No independent fact or authorization.",
                         "items": items})
            last = rows[-1]["revision"] if rows else after
            conn.execute("INSERT OR REPLACE INTO memory_meta(key,value) VALUES('curator_revision_v1',?)", (str(last),))
            status = {"runId": run_id, "mode": "shadow", "fromRevision": after, "toRevision": head,
                      "lastProcessedRevision": last, "morePending": last < head,
                      "eventsScanned": len(rows), "newProposals": len(proposals),
                      "improvementEvents": improvement_events, "invalidImprovementEvents": invalid[:20],
                      "invalidImprovementCount": len(invalid), "proposals": proposals[:20],
                      "proposalPreviewTruncated": len(proposals) > 20,
                      "startedAt": started.isoformat(),
                      "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
            conn.execute("INSERT OR REPLACE INTO memory_meta(key,value) VALUES('curator_last_run_v1',?)", (json.dumps(status, separators=(",", ":")),))
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    print(json.dumps(status, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
