#!/usr/bin/env python3
"""One private room payload into the playbooks room owner (test-room-send-approval.cjs), as the typed helper does.

argv[1]: playbooks checkout; argv[2]: dispatch log (one JSON line per owner process started). stdin: the exact
{command, host, roomAdmission} payload. The dialogue store is the file store under CLAW_DIALOGUE_HOME, so the room
call, Amine's confirmed hand-off and an abort share one conversation across processes. Owner processes are mocked:
nothing reaches WhatsApp. Prints the room owner's result, or {"error": <code>} when it refuses the payload.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

root = Path(sys.argv[1]).resolve()
log = Path(sys.argv[2])
sys.path.insert(0, str(root))
os.environ["CLAW_SERVICE_NOW"] = "1793174400"
from skill_intelligence.capability_graph import CapabilityGraph  # noqa: E402
from skill_intelligence.typed_tools import room_tool_turn  # noqa: E402

payload = json.load(sys.stdin)
tmp = tempfile.mkdtemp()
graph = CapabilityGraph(root, health_path=Path(tmp) / "h", metrics_path=Path(tmp) / "m")


def owner(argv, **kwargs):
    with log.open("a") as out:
        out.write(json.dumps([Path(str(a)).name if i == 1 else str(a) for i, a in enumerate(argv)]) + "\n")
    return subprocess.CompletedProcess(argv, 0, json.dumps({"ok": True, "spoken": "Message envoyé (MOCK)."}), "")


try:
    with mock.patch("subprocess.run", side_effect=owner):
        print(json.dumps(room_tool_turn(graph, payload["command"], payload["host"], payload["roomAdmission"]),
                         ensure_ascii=False))
except ValueError as error:
    print(json.dumps({"error": str(error)}))
