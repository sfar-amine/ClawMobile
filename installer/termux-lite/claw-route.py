#!/data/data/com.termux/files/usr/bin/python3
import argparse, datetime as dt, json, os
from pathlib import Path

HOME=Path.home()
ROOT=HOME/".openclaw"/"remote-bridge"
POLICY=ROOT/"route-policy.json"
HEALTH=ROOT/"slack"/"health.json"
EVENTS=ROOT/"route-events.log"

def load(path):
    try:
        value=json.loads(path.read_text())
        return value if isinstance(value,dict) else {}
    except Exception:
        return {}

def device_eligible():
    h=load(HEALTH)
    return h.get("state")=="healthy" and h.get("mode")=="active" and h.get("connected") is True

def status():
    p=load(POLICY); h=load(HEALTH)
    out={"policy":p,"deviceSlackHealth":h,"deviceSlackEligible":device_eligible()}
    print(json.dumps(out,ensure_ascii=False,indent=2))
    return 0 if p.get("primary")=="slack_remote_bridge" else 2

def event(args):
    ROOT.mkdir(parents=True,exist_ok=True)
    value={
      "ts":dt.datetime.now(dt.timezone.utc).isoformat(),
      "kind":args.kind,"route":args.route,"reason":args.reason,
      "requestId":args.request_id or None,
    }
    with EVENTS.open("a") as f:
        f.write(json.dumps(value,ensure_ascii=False,separators=(",",":"))+"\n")
    os.chmod(EVENTS,0o600)
    print(json.dumps(value,ensure_ascii=False))
    return 0

def main():
    ap=argparse.ArgumentParser()
    sp=ap.add_subparsers(dest="cmd",required=True)
    sp.add_parser("status")
    ev=sp.add_parser("event")
    ev.add_argument("--kind",choices=["primary","fallback","restore","bootstrap"],required=True)
    ev.add_argument("--route",choices=["slack","rdc"],required=True)
    ev.add_argument("--reason",required=True)
    ev.add_argument("--request-id")
    args=ap.parse_args()
    return status() if args.cmd=="status" else event(args)

if __name__=="__main__":
    raise SystemExit(main())
