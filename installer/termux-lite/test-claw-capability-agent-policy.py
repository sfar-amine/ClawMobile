#!/usr/bin/env python3
"""38 E3: the free agent cannot execute an operator or transaction capability.

`claw-capability.py agent-execute` resolves once with the Capability Graph, applies the E3 policy and
executes exactly that decision with `--read-only`. A fake graph module records every call so the test
proves that a refused decision is never executed.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
HELPER = HERE / "claw-capability.py"

FAKE_GRAPH = r'''
import json, os, sys
log = os.environ["E3_GRAPH_LOG"]
args = sys.argv[1:]
stdin = sys.stdin.read() if "--decision-stdin" in args else ""
with open(log, "a", encoding="utf-8") as fh:
    fh.write(json.dumps({"args": args, "stdin": stdin}) + "\n")
cases = json.loads(os.environ["E3_CASES"])
text = args[1]
case = cases[text]
if args[0] == "resolve":
    print(json.dumps(case))
elif args[0] == "execute-decision":
    assert "--read-only" in args, "agent execution must be read-only"
    decision = json.loads(stdin)
    print(json.dumps({"decision": decision, "execution": {"state": "completed", "result": {"ok": True, "text": "lu"}}}))
else:
    raise SystemExit("unexpected " + args[0])
'''


def decision(kind: str, risk: str, target: str | None, choices: list | None = None, confirmation: bool = False) -> dict:
    value = {"version": 2, "type": kind, "risk": risk, "target": target, "confirmationRequired": confirmation}
    if choices is not None:
        value["clarification"] = {"question": "Laquelle ?", "choices": choices}
    return value


def resolution(dec: dict, selected_risk: str | None = None, confirmation: bool = False) -> dict:
    selected = None if selected_risk is None else {"risk": selected_risk, "target": dec.get("target"), "deterministic": True}
    return {"capability_revision": "rev", "decision": dec, "selected": selected, "confirmation_required": confirmation}


CASES = {
    # E1 bug shape: an amount + payment verb resolved as an operator read. Still refused (operator target).
    "recharge 5 dt sur ma ligne orange": resolution(decision("EXECUTE", "read", "maxit-tunisie"), "read"),
    "mon solde orange": resolution(decision("EXECUTE", "read", "maxit-tunisie"), "read"),
    "recharge orange 5 dt": resolution(decision("EXECUTE", "transaction", "maxit-tunisie", confirmation=True), "transaction", True),
    "paie ma facture steg": resolution(decision("EXECUTE", "transaction", "steg"), "transaction", True),
    "envoie un mail": resolution(decision("EXECUTE", "write", None), "write"),
    "orange ou recharge": resolution(decision("CLARIFY", "read", "agenda", [
        {"intent": "agenda.list", "label": "voir", "risk": "read"},
        {"intent": "agenda.create", "label": "créer", "risk": "write"},
    ])),
    "mes rendez-vous": resolution(decision("EXECUTE", "read", "agenda"), "read"),
    "quelle heure est-il": resolution(decision("REASON", "read", None)),
}


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="e3-agent-policy-") as tmp:
        root = Path(tmp)
        (root / "skill_intelligence/manifests").mkdir(parents=True)
        (root / "skill_intelligence/__init__.py").write_text("")
        (root / "skill_intelligence/capability_graph.py").write_text(FAKE_GRAPH)
        for target, family in {"maxit-tunisie": "telecom_selfcare", "steg": "utility_billing", "agenda": "personal_organization"}.items():
            (root / f"skill_intelligence/manifests/{target}.json").write_text(json.dumps({"id": target, "family": family}))
        log = root / "graph.log"
        env = {**os.environ, "CLAW_UI_PLAYBOOKS_ROOT": str(root), "E3_GRAPH_LOG": str(log), "E3_CASES": json.dumps(CASES)}
        checks = 0

        def run(text: str) -> tuple[dict, list[dict]]:
            if log.exists():
                log.unlink()
            proc = subprocess.run([sys.executable, str(HELPER), "agent-execute", text, "--caller", "owner", "--timeout", "5"],
                                  env=env, text=True, capture_output=True, timeout=60)
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            return json.loads(proc.stdout or "{}"), calls

        for text in ("recharge 5 dt sur ma ligne orange", "mon solde orange", "recharge orange 5 dt", "paie ma facture steg", "envoie un mail", "orange ou recharge"):
            out, calls = run(text)
            assert out["execution"] == {"state": "blocked", "reason": "capability_first_required", "executed": False}, (text, out)
            assert out["agent_policy"]["allowed"] is False, out
            assert [c["args"][0] for c in calls] == ["resolve"], (text, calls)  # zero execution
            checks += 3
        out, _ = run("recharge orange 5 dt")
        assert out["agent_policy"]["risk"] == "transaction" and out["agent_policy"]["operator_targets"] == ["maxit-tunisie"]
        out, _ = run("orange ou recharge")
        assert out["agent_policy"]["risk"] == "write"  # CLARIFY risk = highest of its choices
        checks += 2

        for text in ("mes rendez-vous", "quelle heure est-il"):
            out, calls = run(text)
            assert out["agent_policy"]["allowed"] is True, out
            assert [c["args"][0] for c in calls] == ["resolve", "execute-decision"], calls
            assert "--read-only" in calls[1]["args"], calls
            # The executed decision is exactly the resolved one (no second resolution).
            assert json.loads(calls[1]["stdin"]) == CASES[text]["decision"], calls
            checks += 4

    print(f"E3 agent policy: {checks} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
