#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import argparse, datetime as dt, fcntl, hashlib, json, os, re, sqlite3
from pathlib import Path

HOME=Path.home()
STATE=Path(os.environ.get("CLAW_LEARNING_GATE_ROOT", HOME/".openclaw"/"learning-gate"))
WORKSPACE=Path(os.environ.get("CLAW_WORKSPACE", HOME/".openclaw"/"workspace"))
REGISTRY=WORKSPACE/"ui-playbooks"/"capabilities"/"registry.json"
HOWTO_ROOT=WORKSPACE/"ui-playbooks"/"capabilities"/"howto"
JOURNAL=WORKSPACE/"context"/"DEVELOPMENT_JOURNAL.md"
INCIDENT_DB=Path(os.environ.get("CLAW_INCIDENT_DB", HOME/".openclaw"/"incidents"/"orchestrator.db"))
RECEIPTS=STATE/"receipts"
LEDGERS=STATE/"capabilities"
REGISTRY_CANDIDATES=STATE/"registry-candidates"
LOCK=STATE/"gate.lock"
COMPONENT_MAP={
    "slack_bridge":"device.remote_bridge",
    "companion":"device.remote_bridge",
    "remote_bridge":"device.remote_bridge",
    "remote_desktop_commander":"device.remote_desktop",
    "remote_desktop":"device.remote_desktop",
    "adb":"device.adb",
}

def clean(value, limit=1800):
    text=" ".join(str(value or "").split())
    text=re.sub(r"((?:authorization|bearer|token|password|passwd|secret|api[_-]?key|cookie|credential)\s*[:=]\s*)[^\s,;}]+",r"\1<redacted>",text,flags=re.I)
    text=re.sub(r"\b(otp|2fa|verification\s*code|security\s*code)\b\s*[:=\-]?\s*\d{4,8}\b",r"\1 <redacted>",text,flags=re.I)
    return text[:limit]

def safe(value):
    return re.sub(r"[^A-Za-z0-9._-]+","_",str(value or ""))[:128] or "unknown"

def load_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return {} if default is None else default
def capabilities():
    value=load_json(REGISTRY,{})
    return value.get("capabilities",[]) if isinstance(value,dict) else []

def resolve_capability(component, explicit=""):
    ids={str(x.get("id","")):x for x in capabilities()}
    if explicit:
        return explicit if explicit in ids else ""
    if component in ids:
        return component
    mapped=COMPONENT_MAP.get(component,"")
    if mapped in ids:
        return mapped
    needle=component.strip().lower()
    for item in ids.values():
        names=[item.get("name",""),*(item.get("aliases") or [])]
        if any(str(x).strip().lower()==needle for x in names):
            return str(item["id"])
    return ""

def incident_facts(incident_id):
    out={"summary":"","root_cause":"","failed_attempts":[],"final_fix":"","evidence":[]}
    if not incident_id or not INCIDENT_DB.exists():
        return out
    try:
        conn=sqlite3.connect(INCIDENT_DB,timeout=5)
        conn.row_factory=sqlite3.Row
        row=conn.execute("select * from incidents where id=?",(incident_id,)).fetchone()
        events=conn.execute("select source,kind,payload from events where incident_id=? order by seq",(incident_id,)).fetchall()
        conn.close()
    except Exception:
        return out
    if row:
        out["summary"]=clean(row["summary"])
    for ev in events:
        try:
            payload=json.loads(ev["payload"] or "{}")
        except Exception:
            payload={}
        if not isinstance(payload,dict):
            continue
        if not out["root_cause"]:
            for key in ("root_cause","cause"):
                if payload.get(key):
                    out["root_cause"]=clean(payload[key])
                    break
        reason=clean(payload.get("reason",""))
        target=payload.get("to")
        if target in {"diagnosing","repairing","rolling_back"} and reason:
            out["failed_attempts"].append(reason)
        if target=="recovered" and reason:
            out["final_fix"]=reason
    out["failed_attempts"]=list(dict.fromkeys(out["failed_attempts"]))[-8:]
    out["evidence"]=[f"incident:{incident_id}",f"incident_events:{len(events)}"]
    return out
def atomic_json(path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    mode=(path.stat().st_mode & 0o777) if path.exists() else 0o600
    tmp=path.with_name(path.name+f'.tmp-{os.getpid()}')
    tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
    os.chmod(tmp,mode)
    tmp.replace(path)

def append_once(path, marker, text):
    path.parent.mkdir(parents=True,exist_ok=True)
    current=path.read_text(errors='replace') if path.exists() else ''
    if marker in current:
        return False
    with path.open('a') as handle:
        if current and not current.endswith('\n'):
            handle.write('\n')
        handle.write(text)
    return True
def emit_context(record):
    if record["reusable_learning"]:
        payload={
            "target":record["capability_id"] or record["component"],
            "capability":record["capability_id"] or None,
            "intent":f"Prevent recurrence after {record['source']} closure {record['closure_id']}",
            "type":"rule",
            "learning_type":"closure_learning",
            "current_state":{
                "symptom":record["symptom"],
                "root_cause":record["root_cause"],
                "failed_attempts":record["failed_attempts"],
            },
            "proposed_state":{
                "final_fix":record["final_fix"],
                "reusable_learning":record["reusable_learning"],
                "regression_guard":record["regression_guard"],
                "how_to":record["how_to"],
            },
            "evidence":record["evidence"],
            "expected_gain":{"recurrence":"lower","reliability":"higher"},
            "risk":"read",
            "rollback":{"strategy":"retain_prior_operational_rule"},
            "promotion_eligible":False,
            "confidence":record["confidence"],
            "requires_review":record["confidence"]=="provisional",
        }
        return "IMPROVEMENT_CANDIDATE_V1:"+json.dumps(payload,ensure_ascii=False,separators=(",",":"))
    keys=("source","closure_id","component","capability_id","status","symptom","evidence","no_learning_reason","confidence")
    payload={key:record[key] for key in keys}
    return "LEARNING_GATE_V1:"+json.dumps(payload,ensure_ascii=False,separators=(",",":"))

def write_journal(record):
    marker=f"learning-gate:{record['receipt_id']}"
    attempts="; ".join(record["failed_attempts"]) or "none captured"
    body=(
        f"\n<!-- {marker} -->\n"
        f"## Learning Gate — {record['capability_id'] or record['component']} — {record['created_at'][:10]}\n"
        f"- Closure: {record['source']}:{record['closure_id']} -> {record['status']}\n"
        f"- Symptom: {record['symptom'] or 'not captured'}\n"
        f"- Root cause: {record['root_cause'] or 'not established'}\n"
        f"- Failed attempts: {attempts}\n"
        f"- Final fix: {record['final_fix'] or 'not captured'}\n"
        f"- Learning: {record['reusable_learning'] or 'none'}\n"
        f"- Regression guard: {record['regression_guard'] or 'none'}\n"
        f"- Confidence: {record['confidence']}; evidence: {', '.join(record['evidence']) or 'none'}\n"
    )
    return append_once(JOURNAL,marker,body)
def write_howto(record):
    if record["confidence"] not in {"validated","stable"} or not record["capability_id"] or not record["how_to"]:
        return False
    path=HOWTO_ROOT/(safe(record["capability_id"])+".md")
    marker=f"learning-gate:{record['receipt_id']}"
    header="" if path.exists() else f"# {record['capability_id']} — Operational HOW-TO\n\nValidated reusable operating knowledge for this capability.\n"
    bullets="\n".join(f"- {clean(item,1200)}" for item in record["how_to"])
    block=f"{header}\n<!-- {marker} -->\n## {record['created_at'][:10]} — {clean(record['reusable_learning'],500)}\n{bullets}\n"
    return append_once(path,marker,block)

def apply_registry(record):
    if record.get("confidence")!="stable" or not record.get("truth_changed") or not record.get("capability_id"):
        return False
    value=load_json(REGISTRY,{})
    items=value.get("capabilities",[]) if isinstance(value,dict) else []
    target=next((item for item in items if item.get("id")==record["capability_id"]),None)
    if target is None:
        return False
    changed=False
    note=clean(record.get("registry_note"),1200)
    if note and note not in str(target.get("notes","")):
        target["notes"]=(str(target.get("notes","")).rstrip()+" "+note).strip()
        changed=True
    rel=f"capabilities/howto/{safe(record['capability_id'])}.md"
    evidence=target.setdefault("evidence",[])
    if (HOWTO_ROOT/(safe(record["capability_id"])+".md")).exists() and rel not in evidence:
        evidence.append(rel); changed=True
    if changed:
        value["last_verified"]=dt.date.today().isoformat()
        atomic_json(REGISTRY,value)
    return changed

def normalize_list(value):
    if value is None:
        return []
    if isinstance(value,list):
        return [clean(item,1200) for item in value if clean(item,1200)]
    value=clean(value,1200)
    return [value] if value else []

def close(args):
    explicit={}
    learning_path=args.learning_file or os.environ.get("CLAW_LEARNING_FILE","")
    if learning_path:
        explicit=load_json(learning_path,{})
        if not isinstance(explicit,dict):
            raise SystemExit("invalid_learning_file")
    facts=incident_facts(args.incident_id)
    capability=resolve_capability(args.component,args.capability_id or clean(explicit.get("capability_id",""),200))
    symptom=clean(explicit.get("symptom") or facts["summary"] or args.summary)
    root_cause=clean(explicit.get("root_cause") or facts["root_cause"])
    failed=normalize_list(explicit.get("failed_attempts") or facts["failed_attempts"])
    final_fix=clean(explicit.get("final_fix") or args.final_fix or facts["final_fix"])
    learning=clean(explicit.get("reusable_learning"),2400)
    regression=clean(explicit.get("regression_guard"),1800)
    how_to=normalize_list(explicit.get("how_to"))
    evidence=list(dict.fromkeys(normalize_list(explicit.get("evidence"))+facts["evidence"]))
    confidence=str(explicit.get("confidence") or "provisional").lower()
    if confidence not in {"provisional","validated","stable"}:
        confidence="provisional"
    no_learning=clean(explicit.get("no_learning_reason"))
    if not learning and not no_learning:
        no_learning="no_explicit_reusable_learning_supplied"
    base={
        "version":1,
        "source":args.source,
        "closure_id":args.closure_id,
        "component":args.component,
        "capability_id":capability,
        "status":args.status,
        "summary":clean(args.summary),
        "symptom":symptom,
        "root_cause":root_cause,
        "failed_attempts":failed,
        "final_fix":final_fix,
        "reusable_learning":learning,
        "regression_guard":regression,
        "how_to":how_to,
        "evidence":evidence,
        "confidence":confidence,
        "no_learning_reason":no_learning,
        "truth_changed":bool(explicit.get("capability_truth_changed",False)),
        "registry_note":clean(explicit.get("registry_note"),1200),
    }
    canonical=json.dumps(base,ensure_ascii=False,sort_keys=True,separators=(",",":"))
    payload_hash=hashlib.sha256(canonical.encode()).hexdigest()
    receipt_id=hashlib.sha256(f"{args.source}:{args.closure_id}".encode()).hexdigest()[:24]
    receipt_path=RECEIPTS/f"{safe(args.source)}-{safe(args.closure_id)}.json"
    STATE.mkdir(parents=True,exist_ok=True)
    LOCK.touch(exist_ok=True)
    with LOCK.open("r+") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if receipt_path.exists():
            previous=load_json(receipt_path,{})
            if previous.get("payload_hash")!=payload_hash:
                raise SystemExit("closure_id_conflict")
            print(json.dumps(previous,ensure_ascii=False))
            return
        record={
            **base,
            "receipt_id":receipt_id,
            "payload_hash":payload_hash,
            "created_at":dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        record["context_text"]=emit_context(record)
        record["journal_updated"]=write_journal(record)
        record["howto_updated"]=write_howto(record)
        if capability:
            ledger=LEDGERS/f"{safe(capability)}.jsonl"
            ledger.parent.mkdir(parents=True,exist_ok=True)
            with ledger.open("a") as handle:
                handle.write(json.dumps(record,ensure_ascii=False,separators=(",",":"))+"\n")
        if record["truth_changed"] and capability:
            candidate={
                "capability_id":capability,
                "receipt_id":receipt_id,
                "note":record["registry_note"],
                "evidence":record["evidence"],
                "confidence":confidence,
            }
            atomic_json(REGISTRY_CANDIDATES/f"{receipt_id}.json",candidate)
            record["registry_updated"]=apply_registry(record)
            record["registry_update_required"]=not record["registry_updated"]
        else:
            record["registry_updated"]=False
            record["registry_update_required"]=False
        atomic_json(receipt_path,record)
        print(json.dumps(record,ensure_ascii=False))
def main():
    parser=argparse.ArgumentParser()
    subs=parser.add_subparsers(dest="cmd",required=True)
    close_p=subs.add_parser("close")
    close_p.add_argument("--source",required=True,choices=["incident","legacy_incident","engineering","manual"])
    close_p.add_argument("--closure-id",required=True)
    close_p.add_argument("--component",required=True)
    close_p.add_argument("--status",required=True)
    close_p.add_argument("--summary",default="")
    close_p.add_argument("--capability-id",default="")
    close_p.add_argument("--learning-file",default="")
    close_p.add_argument("--incident-id",default="")
    close_p.add_argument("--final-fix",default="")
    args=parser.parse_args()
    if args.cmd=="close":
        close(args)

if __name__=="__main__":
    main()
