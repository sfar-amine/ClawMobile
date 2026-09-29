#!/data/data/com.termux/files/usr/bin/python3
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = os.environ.get(
    "CLAWMOBILE_BRIDGE_URL",
    "http://127.0.0.1:8765/v1/extensions/remote-bridge",
).rstrip("/")


def request(method, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        DEFAULT_BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=310) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw)
        except Exception:
            body = {"error": raw}
        return error.code, body
def build_parser():
    parser = argparse.ArgumentParser(description="Claw Bridge fallback CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("health")

    status = sub.add_parser("status")
    status.add_argument("request_id")

    submit = sub.add_parser("submit")
    submit.add_argument("--request-id", required=True)
    submit.add_argument("--method", required=True)
    submit.add_argument("--task-id")
    submit.add_argument("--session-id")
    submit.add_argument("--params-json", default="{}")
    return parser


def main():
    args = build_parser().parse_args()
    if args.command == "health":
        code, body = request("GET", "/health")
    elif args.command == "status":
        encoded = urllib.parse.quote(args.request_id, safe="")
        code, body = request("GET", f"/requests/{encoded}")
    else:
        params = json.loads(args.params_json)
        payload = {
            "requestId": args.request_id,
            "method": args.method,
            "params": params,
        }
        if args.task_id:
            payload["taskId"] = args.task_id
        if args.session_id:
            payload["sessionId"] = args.session_id
        code, body = request("POST", "/requests", payload)

    print(json.dumps(body, indent=2, ensure_ascii=False))
    if code >= 400:
        return 2
    if isinstance(body, dict) and body.get("state") == "failed":
        return 3
    if isinstance(body, dict) and body.get("state") == "indeterminate":
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
