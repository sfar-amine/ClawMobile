#!/usr/bin/env python3
"""Replay the room brain host's exact private payloads of every typed room into the playbooks room owner
(test-contact-room-brain.cjs).

argv[1]: playbooks checkout. stdin: {"read": …, "write": …, "recap": …, "send": …}, the payloads the host sent for a
device read, a device write, an agenda write the owner would recap and a WhatsApp send. The owners' processes are
mocked; nothing reaches the phone, Google or WhatsApp. Prints one JSON object of observations.
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
os.environ["CLAW_SERVICE_NOW"] = "1793174400"
from skill_intelligence.capability_graph import CapabilityGraph  # noqa: E402
from skill_intelligence.typed_tools import room_tool_turn  # noqa: E402
from tests.dialogue_fakes import TempStore  # noqa: E402

payloads = json.load(sys.stdin)
tmp = tempfile.mkdtemp()
graph = CapabilityGraph(root, health_path=Path(tmp) / "h", metrics_path=Path(tmp) / "m")
store_dir = TempStore()
store = store_dir.store()
dispatched = []


def owner(argv, **kwargs):
    dispatched.append([Path(str(a)).name if i == 1 else str(a) for i, a in enumerate(argv[1:], 1)])
    return subprocess.CompletedProcess(argv, 0, json.dumps({"ok": True, "spoken": "Fait (MOCK)."}), "")


def turn(payload):
    dispatched.clear()
    with mock.patch("subprocess.run", side_effect=owner):
        out = room_tool_turn(graph, payload["command"], payload["host"], payload["roomAdmission"], store=store)
    return {**out, "dispatched": [list(d) for d in dispatched]}


def follow(payload, operation, **extra):
    out = turn(payload)
    if out.get("prepared"):
        then = {**copy.deepcopy(payload), "command": {"operation": operation, "domain": payload["command"]["domain"],
                                                     "goalRef": out["prepared"]["goalRef"], **extra}}
        out = {"call": out, "next": turn(then), "again": turn(then)}
    return out


out = {"read": turn(payloads["read"]),
       "write": follow(payloads["write"], "handoff"),
       "recap": follow(payloads["recap"], "handoff"),
       "send": follow(payloads["send"], "abort", reason="admission_revoked")}
private = copy.deepcopy(payloads["read"])
private["host"]["invocationId"] += "-sms"
private["roomAdmission"]["event_ref"] += "-sms"
private["command"] = {"operation": "call", "domain": "device-assistance", "action": "device.sms.latest", "params": {}}
out["owner_private"] = turn(private)
foreign = copy.deepcopy(payloads["read"])
foreign["command"] = {"operation": "call", "domain": "pulse", "action": "project.search", "params": {}}
out["foreign_domain"] = turn(foreign)
owner_host = copy.deepcopy(payloads["read"])
owner_host["host"]["owner"] = True
try:
    turn(owner_host)
    out["owner_principal_refused"] = False
except ValueError:
    out["owner_principal_refused"] = True
store.close()
store_dir.cleanup()
print(json.dumps(out, ensure_ascii=False))
