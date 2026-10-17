#!/usr/bin/env python3
"""Reconcile only the description of the existing memory curator cron job."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


DECLARATION_KEY = "claw:cross-surface-memory-curator"
DESCRIPTION = (
    "Curateur déterministe de la mémoire commune à 22:10 Africa/Tunis, "
    "en mode shadow ; le dreaming natif reste désactivé et aucune sortie "
    "du shadow n'est autorisée avant une évaluation M5 non régressive."
)


def load_jobs(source: Path | None = None) -> dict[str, Any]:
    if source is not None:
        return json.loads(source.read_text(encoding="utf-8"))
    completed = subprocess.run(
        ["openclaw", "cron", "list", "--json"],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def select_curator(payload: dict[str, Any]) -> dict[str, Any]:
    jobs = payload.get("jobs")
    if not isinstance(jobs, list):
        raise ValueError("cron_jobs_missing")
    matches = [job for job in jobs if job.get("declarationKey") == DECLARATION_KEY]
    if len(matches) != 1:
        raise ValueError(f"curator_job_count:{len(matches)}")
    job = matches[0]
    if not isinstance(job.get("id"), str) or not job["id"]:
        raise ValueError("curator_job_id_missing")
    schedule = job.get("schedule")
    if schedule != {"kind": "cron", "expr": "10 22 * * *", "tz": "Africa/Tunis"}:
        raise ValueError("curator_schedule_unexpected")
    argv = (job.get("payload") or {}).get("argv")
    if not isinstance(argv, list) or not any(
        isinstance(value, str) and value.endswith("/context-dream.sh") for value in argv
    ):
        raise ValueError("curator_command_unexpected")
    if job.get("enabled") is not True:
        raise ValueError("curator_job_disabled")
    return job


def stable_contract(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "declarationKey": job.get("declarationKey"),
        "name": job.get("name"),
        "displayName": job.get("displayName"),
        "enabled": job.get("enabled"),
        "schedule": job.get("schedule"),
        "sessionTarget": job.get("sessionTarget"),
        "wakeMode": job.get("wakeMode"),
        "payload": job.get("payload"),
        "delivery": job.get("delivery"),
    }


def reconcile(source: Path | None, apply: bool) -> dict[str, Any]:
    before = select_curator(load_jobs(source))
    if before.get("description") == DESCRIPTION:
        return {"state": "unchanged", "jobId": before["id"], "description": DESCRIPTION}
    if not apply:
        return {
            "state": "planned",
            "jobId": before["id"],
            "previousDescription": before.get("description"),
            "description": DESCRIPTION,
        }
    if source is not None:
        raise ValueError("apply_with_fixture_forbidden")
    before_contract = stable_contract(before)
    subprocess.run(
        ["openclaw", "cron", "edit", before["id"], "--description", DESCRIPTION, "--json"],
        check=True,
        capture_output=True,
        text=True,
    )
    after = select_curator(load_jobs())
    if after.get("description") != DESCRIPTION:
        raise RuntimeError("curator_description_not_applied")
    if stable_contract(after) != before_contract:
        raise RuntimeError("curator_contract_changed")
    return {"state": "updated", "jobId": after["id"], "description": DESCRIPTION}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--list-json", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(reconcile(args.list_json, args.apply), ensure_ascii=False))
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        print(json.dumps({"state": "failed", "reason": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
