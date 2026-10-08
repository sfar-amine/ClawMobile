#!/usr/bin/env python3
from __future__ import annotations
import importlib.util
import subprocess
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
PATH=ROOT.parent/"installer"/"termux-lite"/"model-fast-path.py"
spec=importlib.util.spec_from_file_location("model_fast_path",PATH)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def resolution(risk="read",mode="durable"):
    return {
        "capability":"device.assistance",
        "selected":{"capability":"device.assistance","risk":risk,"state":"ready","authorized":True,"deterministic":True,"model_required":False},
        "continuum":{"mode":mode,"durable":mode=="durable","identity_required":mode=="durable"},
        "harness":{"tool_policy":"required"},
    }

def receipt(request_id,risk="read"):
    return {"requestId":request_id,"state":"completed","mutationRisk":risk,
            "result":{"capability":"device.assistance","selected":{"capability":"device.assistance","risk":risk},
                      "execution":{"state":"completed","result":{"ok":True,"kind":risk}}}}

def expected_request(origin):
    task=m._stable_identity("capfirst",origin)
    return "capfirst-"+m.hashlib.sha256((task+":execute").encode()).hexdigest()[:32]

def run_success():
    calls=[];origin="run-durable-read";rid=expected_request(origin)
    def ingress(_root,args,timeout=15):
        calls.append(("ingress",list(args)))
        if args[0]=="prepare": return {"state":"ready","dispatch_allowed":True,"wire_step_id":"continuum-step","continuum_fence":None}
        return {"state":"settled_read","mission_state":"completed","retry_authorized":False}
    def runner(cmd,**kwargs):
        calls.append(("run",list(cmd)))
        return 0,receipt(rid,"read"),""
    with patch.object(m,"_continuum_call",side_effect=ingress),patch.object(m,"_run_json",side_effect=runner),patch.object(m,"_bridge_cli",return_value=Path("/bridge")):
        out=m._durable_capability_execute(resolution(),"durable read",ui_root=ROOT,surface="claw_live",caller="owner",origin_id=origin,timeout=10)
    submits=[x for x in calls if x[0]=="run"]
    assert len(submits)==1,calls
    assert out["execution"]["state"]=="completed"
    assert out["continuum"]["mission_state"]=="completed"
    return {"submit_count":len(submits),"settled":True}

def run_response_loss():
    calls=[];origin="run-response-loss";rid=expected_request(origin)
    def ingress(_root,args,timeout=15):
        calls.append(("ingress",list(args)))
        if args[0]=="prepare": return {"state":"ready","dispatch_allowed":True,"wire_step_id":"continuum-step","continuum_fence":None}
        return {"state":"settled_read","mission_state":"completed","retry_authorized":False}
    def runner(cmd,**kwargs):
        calls.append(("run",list(cmd)))
        raise subprocess.TimeoutExpired(cmd,1)
    with patch.object(m,"_continuum_call",side_effect=ingress),patch.object(m,"_run_json",side_effect=runner),patch.object(m,"_bridge_cli",return_value=Path("/bridge")),patch.object(m,"_bridge_status",return_value=receipt(rid,"read")):
        out=m._durable_capability_execute(resolution(),"durable read",ui_root=ROOT,surface="claw_live",caller="owner",origin_id=origin,timeout=10)
    submits=[x for x in calls if x[0]=="run"]
    assert len(submits)==1,calls
    assert out["execution"]["state"]=="completed"
    return {"submit_count":len(submits),"status_lookup_recovered":True}

def run_write_fence():
    calls=[];origin="run-write";rid=expected_request(origin)
    fence={"version":1,"attemptId":"a1","effectKey":"e1","ownershipEpoch":1,"ownerId":"owner","bootId":"boot"}
    def ingress(_root,args,timeout=15):
        calls.append(("ingress",list(args)))
        if args[0]=="prepare": return {"state":"ready","dispatch_allowed":True,"wire_step_id":"continuum-step","continuum_fence":fence}
        return {"protocol_state":"verification_required","state":"verification_required","retry_authorized":False}
    def runner(cmd,**kwargs):
        calls.append(("run",list(cmd)))
        assert "--continuum-fence-json" in cmd
        return 0,receipt(rid,"write"),""
    with patch.object(m,"_continuum_call",side_effect=ingress),patch.object(m,"_run_json",side_effect=runner),patch.object(m,"_bridge_cli",return_value=Path("/bridge")):
        out=m._durable_capability_execute(resolution("write"),"write fixture",ui_root=ROOT,surface="claw_live",caller="owner",origin_id=origin,timeout=10)
    assert out["continuum"]["state"]=="verification_required"
    return {"fence_forwarded":True,"verification_required":True}

if __name__=="__main__":
    import json
    result={"success":run_success(),"response_loss":run_response_loss(),"write":run_write_fence()}
    print(json.dumps({"suite":"model-fast-path-durable","passed":True,**result},sort_keys=True))
