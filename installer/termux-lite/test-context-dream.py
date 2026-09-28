#!/data/data/com.termux/files/usr/bin/python3
from contextlib import closing
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import tempfile

SRC = pathlib.Path(os.environ.get("SAMANTHA_TERMUX_LITE_SRC", pathlib.Path(__file__).resolve().parent))
tmp = pathlib.Path(tempfile.mkdtemp(prefix="dream-test."))
home = tmp / "home"
home.mkdir()
root = home / ".openclaw/context-sync"
hy = home / ".openclaw/workspace/context/HYBRID_CONTEXT.md"
hy.parent.mkdir(parents=True)
hy.write_text("# dream\n")
env = os.environ.copy()
env.update(
    HOME=str(home),
    SAMANTHA_CONTEXT_ROOT=str(root),
    SAMANTHA_HYBRID_PATH=str(hy),
    SAMANTHA_IMPROVEMENT_BRIDGE="0",
)

def run(name, *args):
    return subprocess.run(
        [str(SRC / name), *args],
        env=env,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()

run("context-event.sh", "chat", "learning", "DREAM duplicate fact")
run("context-event.sh", "work", "learning", "DREAM duplicate fact")
old = run("context-event.sh", "chat", "decision", "DREAM old fact")
run("context-event.sh", "chat", "decision", "--supersedes", old, "DREAM new fact")
candidate = {
    "target": "demo",
    "capability": "demo.read",
    "intent": "demo.read",
    "type": "route",
    "current_state": {"route": "demo.direct"},
    "proposed_state": {"route": "demo.fast"},
    "evidence": [{"source": "test"}],
    "expected_gain": {"latency": "lower"},
    "risk": "read",
    "rollback": {"strategy": "restore_previous_route"},
}
event = "IMPROVEMENT_CANDIDATE_V1:" + json.dumps(candidate, sort_keys=True, separators=(",", ":"))
run("context-event.sh", "chat", "learning", event)

with closing(sqlite3.connect(root / "memory.db")) as conn:
    before = conn.execute("select count(*) from events").fetchone()[0]
r1 = json.loads(run("context-dream.sh"))
r2 = json.loads(run("context-dream.sh"))
with closing(sqlite3.connect(root / "memory.db")) as conn:
    after = conn.execute("select count(*) from events").fetchone()[0]
    actions = [x[0] for x in conn.execute("select action from dream_proposals order by action")]

assert before == after == 5
assert actions == ["confirm_supersession", "consolidate_duplicate", "improvement_candidate"], actions
assert r1["newProposals"] == 3
assert r1["improvementEvents"] == 1
assert r1["invalidImprovementEvents"] == []
assert r1["improvementBridge"]["state"] == "noop"
assert r2["newProposals"] == 0
print("PASS D01 shadow proposals immutable + idempotent + structured improvement")
print("RESULT 1/1 PASS")
shutil.rmtree(tmp, ignore_errors=True)
