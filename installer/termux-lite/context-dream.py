#!/data/data/com.termux/files/usr/bin/python3
"""Shadow-only cross-surface memory curator."""
from contextlib import closing
import datetime
import hashlib
import json
import os
import pathlib
import sqlite3
import uuid

H = pathlib.Path.home()
D = pathlib.Path(os.environ.get("SAMANTHA_CONTEXT_ROOT", H / ".openclaw/context-sync"))
DB = D / "memory.db"
IMPROVEMENT_PREFIX = "IMPROVEMENT_CANDIDATE_V1:"

def norm(text):
    return " ".join(text.lower().split())

def parse_improvement(text):
    if not text.startswith(IMPROVEMENT_PREFIX):
        return None
    raw = text[len(IMPROVEMENT_PREFIX):].strip()
    value = json.loads(raw)
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
    with closing(sqlite3.connect(DB, timeout=30)) as conn:
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute(
            """CREATE TABLE IF NOT EXISTS dream_proposals(
            proposal_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            action TEXT NOT NULL,
            source_ids TEXT NOT NULL,
            payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'proposed',
            created_at TEXT NOT NULL,
            applied_at TEXT)"""
        )
        rows = conn.execute(
            "SELECT id,revision,surface,kind,text,created_at,supersedes FROM events ORDER BY revision"
        ).fetchall()
        active = {row[0]: row for row in rows}
        superseded = {row[6] for row in rows if row[6]}
        for source_id in superseded:
            active.pop(source_id, None)

        run_id = (
            datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            + "-"
            + uuid.uuid4().hex[:8]
        )
        proposals = []

        def propose(action, ids, payload):
            ids = sorted(set(ids))
            canonical = json.dumps(
                {"action": action, "source_ids": ids, "payload": payload},
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
            )
            proposal_id = hashlib.sha256(canonical.encode()).hexdigest()
            conn.execute(
                """INSERT OR IGNORE INTO dream_proposals(
                proposal_id,run_id,action,source_ids,payload,status,created_at
                ) VALUES(?,?,?,?,?,'proposed',?)""",
                (
                    proposal_id,
                    run_id,
                    action,
                    json.dumps(ids, separators=(",", ":")),
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    datetime.datetime.now(datetime.timezone.utc).isoformat(),
                ),
            )
            if conn.execute("SELECT changes()").fetchone()[0]:
                proposals.append(
                    {
                        "proposalId": proposal_id,
                        "action": action,
                        "sourceIds": ids,
                        "payload": payload,
                    }
                )

        groups = {}
        for row in active.values():
            groups.setdefault((row[3], norm(row[4])), []).append(row)
        for (kind, text), group in groups.items():
            if len(group) > 1:
                propose(
                    "consolidate_duplicate",
                    [item[0] for item in group],
                    {"kind": kind, "normalizedText": text},
                )

        for row in rows:
            if row[6]:
                propose(
                    "confirm_supersession",
                    [row[6], row[0]],
                    {"superseded": row[6], "replacement": row[0]},
                )

        invalid_improvement_events = []
        improvement_events = 0
        for row in active.values():
            if row[3] != "learning" or not row[4].startswith(IMPROVEMENT_PREFIX):
                continue
            try:
                payload = parse_improvement(row[4])
                payload.setdefault("origin_class", "cross_surface:" + str(row[2]))
                confidence = str(payload.get("confidence") or "provisional").lower()
                payload.setdefault("trust", {"stable":"authoritative","validated":"verified"}.get(confidence,"provisional"))
                propose("improvement_candidate", [row[0]], payload)
                improvement_events += 1
            except Exception as exc:
                invalid_improvement_events.append(
                    {"sourceId": row[0], "error": str(exc)}
                )

        conn.commit()
    print(
        json.dumps(
            {
                "runId": run_id,
                "mode": "shadow",
                "eventsScanned": len(rows),
                "newProposals": len(proposals),
                "improvementEvents": improvement_events,
                "invalidImprovementEvents": invalid_improvement_events,
                "proposals": proposals,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )

if __name__ == "__main__":
    main()
