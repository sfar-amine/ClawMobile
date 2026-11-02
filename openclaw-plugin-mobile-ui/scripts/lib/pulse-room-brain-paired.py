#!/usr/bin/env python3
"""Replay the room brain host's exact private payloads into the playbooks room owner (test-pulse-room-brain.cjs).

argv[1]: playbooks checkout. stdin: the JSON list of payloads the host sent ([read, write]). Pulse processes are
mocked with the playbooks MOCK fixture (tests/fixtures/native-pulse-phase-mock.json); nothing reaches Pulse.
Prints one JSON object of observations.
"""
import copy
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root))
os.environ["CLAW_SERVICE_NOW"] = "1793174400"  # Wed 28/10 09:00 Tunis: Pulse open
from skill_intelligence.capability_graph import CapabilityGraph  # noqa: E402
from skill_intelligence.typed_tools import room_tool_turn  # noqa: E402
from tests.dialogue_fakes import TempStore  # noqa: E402

payloads = json.load(sys.stdin)
fixture = json.loads((root / "tests/fixtures/native-pulse-phase-mock.json").read_text())
tmp = tempfile.mkdtemp()
graph = CapabilityGraph(root, health_path=Path(tmp) / "h", metrics_path=Path(tmp) / "m")
store_dir = TempStore()
store = store_dir.store()
dispatched = []


def owner(argv, **kwargs):
    dispatched.append([Path(str(a)).name if i == 1 else str(a) for i, a in enumerate(argv[1:], 1)])
    if argv[-1] == "--prepare-command":
        return subprocess.CompletedProcess(argv, 0, json.dumps(fixture["prepared"]), "")
    if argv[-1] == "--prepared-command-stdin":
        return subprocess.CompletedProcess(argv, 0, json.dumps(fixture["execution"]["result"]), "")
    return subprocess.CompletedProcess(argv, 0, json.dumps({"ok": True, "qualification": "MOCK_ONLY", "items": []}), "")


def turn(payload):
    dispatched.clear()
    with mock.patch("subprocess.run", side_effect=owner):
        out = room_tool_turn(graph, payload["command"], payload["host"], payload["roomAdmission"], store=store)
    return {**out, "dispatched": dispatched[-1] if dispatched else []}


read, write = payloads
out = {"read": turn(read), "write_prepared": turn(write)}
handoff = {**copy.deepcopy(write), "command": {"operation": "handoff", "domain": "pulse",
                                              "goalRef": out["write_prepared"]["prepared"]["goalRef"]}}
out["handoff"] = turn(handoff)
again = turn(handoff)
out["replayed_handoff_dispatches"] = len(again["dispatched"])
owner_host = copy.deepcopy(read)
owner_host["host"]["owner"] = True
try:
    turn(owner_host)
    out["owner_principal_refused"] = False
except ValueError:
    out["owner_principal_refused"] = True
foreign = copy.deepcopy(read)
foreign["command"] = {"operation": "call", "domain": "agenda", "action": "agenda.read", "params": {}}
out["foreign_domain"] = turn(foreign)
leave = copy.deepcopy(read)
leave["host"]["invocationId"] += "-leave"
leave["roomAdmission"]["event_ref"] += "-leave"
leave["command"] = {"operation": "call", "domain": "pulse", "action": "leave.request",
                    "params": {"start_at": "2026-11-10", "end_at": "2026-11-12"}}
out["leave_owner"] = turn(leave)
store.close()
store_dir.cleanup()
print(json.dumps(out, ensure_ascii=False))
