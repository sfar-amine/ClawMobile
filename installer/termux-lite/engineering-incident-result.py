#!/data/data/com.termux/files/usr/bin/python3
"""Translate bounded engineering outcomes into canonical incident states."""
import importlib.util
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("canonical_orchestrator",ROOT/"incident-orchestrator.py")
O=importlib.util.module_from_spec(spec);spec.loader.exec_module(O)
WAIT={"waiting_model","model_unavailable","rate_limit","timeout","auth_unavailable","billing","unavailable","busy","interrupted"}

def apply(iid,result):
    current=O.show(iid)["incident"]
    if not current:raise ValueError("unknown canonical incident")
    if current["state"] in O.TERMINAL:return {"status":"already_terminal","state":current["state"]}
    status=result.get("status","invalid_output")
    summary={k:result.get(k) for k in ("status","model","actual_model","attempts","commit","learning_status")}
    if not isinstance(summary.get("attempts"),(int,list,type(None))):summary.pop("attempts",None)
    O.observe(iid,"engineering-controller","engineering_result",summary)
    if status=="success":
        if (result.get("repair_decision") or {}).get("disposition")=="rejected":
            return O.transition(iid,"failed","engineering-controller","model recommended an unauthorized action")
        return O.transition(iid,"planning","engineering-controller","diagnosis verified; managed checks still required")
    if status=="recovered":
        return O.recover_incident(current["component"],current["scope"],"engineering-controller","code repair passed independent and live gates; continuation dispatched")
    if status=="candidate_verified":
        return O.transition(iid,"waiting_validation","engineering-controller","candidate verified; production acceptance gate not yet enabled")
    if status in WAIT:
        reason=result.get("reason") or status
        if status=="interrupted":
            retries=sum(1 for e in O.show(iid)["events"] if e["kind"]=="engineering_result" and json.loads(e["payload"]).get("status")=="interrupted")
            if retries>2:return O.transition(iid,"failed","engineering-controller","controller interruption budget exhausted; effect receipts retained")
        if status!="interrupted" and (result.get("governor") or {}).get("total_calls",0)>=4:
            return O.transition(iid,"failed","engineering-controller","bounded model budget exhausted; repair checkpoint retained")
        delay=300 if reason in {"auth_unavailable","billing"} else 60
        return O.transition(iid,"waiting_model","engineering-controller",str(reason)[:100],retry_after_s=delay)
    return O.transition(iid,"failed","engineering-controller",str(status)[:100]+"; no recovery declared")

if __name__=="__main__":
    iid,path=sys.argv[1:3]
    result=json.loads(Path(path).read_text())
    print(json.dumps(apply(iid,result),ensure_ascii=False))
