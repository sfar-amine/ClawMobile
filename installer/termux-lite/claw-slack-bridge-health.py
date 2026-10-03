#!/data/data/com.termux/files/usr/bin/python3
import json
import os
import pathlib
import time

BASE = pathlib.Path(os.environ.get("CLAW_SLACK_STATE_DIR", pathlib.Path.home() / ".openclaw" / "remote-bridge" / "slack"))
CONFIG = pathlib.Path(os.environ.get("CLAW_SLACK_CONFIG", BASE / "config.json"))
HEALTH = BASE / "health.json"
MAX_HEARTBEAT_AGE_S = float(os.environ.get("CLAW_SLACK_MAX_HEARTBEAT_AGE_S", "60"))

def expand(value):
    return pathlib.Path(os.path.expanduser(str(value)))

def output(state, **extra):
    print(json.dumps({"state": state, **extra}, separators=(",", ":")))

try:
    config = json.loads(CONFIG.read_text())
except Exception:
    output("setup_required", reason="config_missing")
    raise SystemExit(2)

channel = str(config.get("channelId") or "").strip()
users = [str(x).strip() for x in config.get("allowedUserIds") or [] if str(x).strip()]
app_file = expand(config.get("appTokenFile") or BASE / "secrets" / "app-token")
bot_file = expand(config.get("botTokenFile") or BASE / "secrets" / "bot-token")
if not channel or not users or not app_file.is_file() or not bot_file.is_file():
    output("setup_required", reason="config_or_secret_missing")
    raise SystemExit(2)

try:
    health = json.loads(HEALTH.read_text())
except Exception:
    output("degraded", reason="health_missing")
    raise SystemExit(1)

heartbeat_ms = float(health.get("heartbeatAt") or health.get("updatedAt") or 0)
age = max(0, time.time() - heartbeat_ms / 1000)
runtime_root = str(health.get("runtimeRoot") or "")
if (age <= MAX_HEARTBEAT_AGE_S and health.get("connected") is True
        and health.get("restartRecommended") is False
        and health.get("deliveryState") == "attention_required"):
    output("degraded", reason="delivery_attention", restartRecommended=False,
           queue=health.get("queue", {}), ageSeconds=round(age, 3), runtimeRoot=runtime_root)
    raise SystemExit(3)
if health.get("state") == "healthy" and health.get("connected") is True and age <= MAX_HEARTBEAT_AGE_S:
    output("healthy", ageSeconds=round(age, 3), runtimeRoot=runtime_root)
    raise SystemExit(0)

reason = "heartbeat_stale" if age > MAX_HEARTBEAT_AGE_S else "bridge_not_healthy"
output("degraded", reason=reason, reportedState=str(health.get("state") or "unknown"), ageSeconds=round(age, 3), runtimeRoot=runtime_root)
raise SystemExit(1)
