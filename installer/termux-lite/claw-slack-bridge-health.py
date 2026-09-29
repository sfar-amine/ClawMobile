#!/data/data/com.termux/files/usr/bin/python3
import json
import os
import pathlib
import sys
import time

BASE = pathlib.Path(os.environ.get("CLAW_SLACK_STATE_DIR", pathlib.Path.home() / ".openclaw" / "remote-bridge" / "slack"))
CONFIG = pathlib.Path(os.environ.get("CLAW_SLACK_CONFIG", BASE / "config.json"))
HEALTH = BASE / "health.json"

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

age = max(0, time.time() - (float(health.get("updatedAt") or 0) / 1000))
if health.get("state") == "healthy" and health.get("connected") is True and age <= 60:
    output("healthy", ageSeconds=round(age, 3))
    raise SystemExit(0)

output(str(health.get("state") or "degraded"), ageSeconds=round(age, 3))
raise SystemExit(1)
