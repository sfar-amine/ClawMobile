#!/data/data/com.termux/files/usr/bin/python3
import concurrent.futures
import json
import pathlib
import statistics
import time
import urllib.error
import urllib.request
import uuid

BASE = "http://127.0.0.1:8765/v1/extensions/remote-bridge"
ROOT = pathlib.Path.home() / ".openclaw" / "remote-bridge"
TEST_FILE = ROOT / "acceptance-runtime.txt"

def request(method, path, payload=None, timeout=60):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            body = json.loads(raw)
        except Exception:
            body = {"raw": raw}
        return error.code, body
def submit(request_id, method, params):
    return request(
        "POST",
        "/requests",
        {
            "requestId": request_id,
            "taskId": "runtime-acceptance",
            "sessionId": "chat-current",
            "method": method,
            "params": params,
        },
    )

def request_id(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:10]}"

def percentile(values, pct):
    ordered = sorted(values)
    index = int(pct * (len(ordered) - 1))
    return ordered[index]

def main():
    try:
        TEST_FILE.unlink()
    except FileNotFoundError:
        pass
    report = {"startedAt": time.time()}
    code, health = request("GET", "/health")
    report["health"] = {"code": code, "body": health}
    write_id = request_id("accept-write")
    payload = {"path": str(TEST_FILE), "content": "X", "mode": "append"}
    _, first = submit(write_id, "write_file", payload)
    _, second = submit(write_id, "write_file", payload)
    report["idempotentWrite"] = {
        "first": first.get("state"),
        "second": second.get("state"),
        "content": TEST_FILE.read_text(),
    }

    conflict_code, conflict = submit(
        write_id,
        "write_file",
        {"path": str(TEST_FILE), "content": "Y", "mode": "append"},
    )
    report["conflict"] = {
        "code": conflict_code,
        "error": conflict.get("message") or conflict.get("error"),
    }

    _, read = submit(
        request_id("accept-read"),
        "read_file",
        {"path": str(TEST_FILE), "offset": 0, "length": 10},
    )
    report["read"] = {
        "state": read.get("state"),
        "text": (read.get("result") or {}).get("text"),
    }
    _, executed = submit(
        request_id("accept-exec"),
        "exec_wait",
        {"command": "printf hello", "timeoutMs": 5000},
    )
    report["exec"] = {
        "state": executed.get("state"),
        "stdout": (executed.get("result") or {}).get("stdout"),
        "exitCode": (executed.get("result") or {}).get("exitCode"),
    }

    _, started = submit(
        request_id("accept-process"),
        "process_start",
        {"command": "printf A; sleep 0.25; printf B"},
    )
    process_id = (started.get("result") or {}).get("processId")
    time.sleep(0.4)
    _, status = submit(
        request_id("accept-status"),
        "process_status",
        {"processId": process_id, "offset": 0},
    )
    report["process"] = {
        "processId": process_id,
        "state": (status.get("result") or {}).get("state"),
        "output": (status.get("result") or {}).get("output"),
    }
    _, large = submit(
        request_id("accept-large"),
        "exec_wait",
        {"command": "python3 -c 'print(\"Z\"*70000)'", "timeoutMs": 5000},
    )
    artifact = ((large.get("result") or {}).get("artifact") or {})
    artifact_id = artifact.get("artifactId")
    _, chunk = submit(
        request_id("accept-artifact"),
        "artifact_read",
        {"artifactId": artifact_id, "offset": 0, "maxBytes": 100},
    )
    report["artifact"] = {
        "artifactId": artifact_id,
        "bytes": artifact.get("bytes"),
        "chunkBytes": len((chunk.get("result") or {}).get("text", "")),
    }

    sequential = []
    for index in range(120):
        started_at = time.perf_counter()
        submit(request_id(f"accept-ping-s-{index}"), "ping", {})
        sequential.append((time.perf_counter() - started_at) * 1000)
    report["sequentialPingMs"] = {
        "n": len(sequential),
        "p50": round(statistics.median(sequential), 3),
        "p95": round(percentile(sequential, 0.95), 3),
        "max": round(max(sequential), 3),
    }

    def one(index):
        started_at = time.perf_counter()
        submit(request_id(f"accept-ping-c-{index}"), "ping", {})
        return (time.perf_counter() - started_at) * 1000

    burst_started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        concurrent_values = list(executor.map(one, range(100)))
    wall_ms = (time.perf_counter() - burst_started) * 1000
    report["concurrentPing"] = {
        "n": 100,
        "workers": 10,
        "wallMs": round(wall_ms, 3),
        "rps": round(100 / (wall_ms / 1000), 2),
        "p50Ms": round(statistics.median(concurrent_values), 3),
        "p95Ms": round(percentile(concurrent_values, 0.95), 3),
        "maxMs": round(max(concurrent_values), 3),
    }
    report["finishedAt"] = time.time()
    print(json.dumps(report, indent=2))
    try:
        TEST_FILE.unlink()
    except FileNotFoundError:
        pass

if __name__ == "__main__":
    main()
