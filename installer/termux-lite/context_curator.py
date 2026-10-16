"""Audited, temporal projection of the immutable shared-memory event owner.

Only explicit author events are applied.  The curator never guesses that two
different texts mean the same thing and never edits or deletes ``events``.
"""
from __future__ import annotations

import datetime
import hashlib

from context_memory import RETIRE_PREFIX, TELEMETRY

INVALIDATE_PREFIXES = (RETIRE_PREFIX, "MEMORY_FORGET_V1 ")


def _timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError("invalid_fact_validity")
    stamp = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("invalid_fact_validity")
    return stamp.isoformat()


def _audit_id(action, event_id, prior_event_id):
    return hashlib.sha256(("curator-v1\0" + action + "\0" + event_id + "\0" + (prior_event_id or "")).encode()).hexdigest()


def apply_actions(conn, rows, run_id, observed_at):
    """Apply deterministic ADD/UPDATE/INVALIDATE actions to the derived projection.

    ``rows`` are ordered immutable owner events. Supersession is the only UPDATE or
    INVALIDATE authority. Duplicate proposals remain proposals while mode is shadow.
    """
    observed = _timestamp(observed_at.isoformat() if hasattr(observed_at, "isoformat") else observed_at)
    counts = {"ADD": 0, "UPDATE": 0, "INVALIDATE": 0}
    invalid = []
    for row in rows:
        event_id = row["id"]
        text = row["text"] or ""
        prior_id = row["supersedes"]
        invalidate = bool(prior_id and text.startswith(INVALIDATE_PREFIXES))
        if TELEMETRY.match(text) and not invalidate:
            continue
        try:
            valid_from = _timestamp(row["createdAt"])
        except (ValueError, TypeError, AttributeError) as exc:
            invalid.append({"sourceId": event_id, "error": str(exc)})
            continue
        already = conn.execute("SELECT 1 FROM curator_audit WHERE event_id=? LIMIT 1", (event_id,)).fetchone()
        if already:
            continue
        prior = conn.execute("SELECT root_event_id,valid_from,valid_to,state FROM curated_facts WHERE event_id=?", (prior_id,)).fetchone() if prior_id else None
        if invalidate:
            if not prior:
                # The projection may be catching up in bounded batches. The receipt is
                # reconsidered after its source has been materialized.
                continue
            conn.execute("UPDATE curated_facts SET valid_to=COALESCE(valid_to,?),state='invalidated',invalidated_by=? WHERE event_id=?",
                         (valid_from, event_id, prior_id))
            action = "INVALIDATE"
            root_id = prior[0]
            audit_from, audit_to = prior[1], valid_from
        elif prior_id and prior:
            conn.execute("UPDATE curated_facts SET valid_to=COALESCE(valid_to,?),state='superseded',invalidated_by=? WHERE event_id=?",
                         (valid_from, event_id, prior_id))
            conn.execute("INSERT INTO curated_facts(event_id,root_event_id,valid_from,valid_to,observed_at,state,invalidated_by) VALUES(?,?,?,NULL,?,'active',NULL)",
                         (event_id, prior[0], valid_from, observed))
            action = "UPDATE"
            root_id = prior[0]
            audit_from, audit_to = valid_from, None
        else:
            conn.execute("INSERT INTO curated_facts(event_id,root_event_id,valid_from,valid_to,observed_at,state,invalidated_by) VALUES(?,?,?,NULL,?,'active',NULL)",
                         (event_id, event_id, valid_from, observed))
            action = "ADD"
            root_id = event_id
            audit_from, audit_to = valid_from, None
        conn.execute("INSERT INTO curator_audit(audit_id,run_id,action,event_id,prior_event_id,valid_from,valid_to,observed_at) VALUES(?,?,?,?,?,?,?,?)",
                     (_audit_id(action, event_id, prior_id), run_id, action, event_id, prior_id, audit_from, audit_to, observed))
        counts[action] += 1
    return {"counts": counts, "invalid": invalid[:20], "invalidCount": len(invalid)}
