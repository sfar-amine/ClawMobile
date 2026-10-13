#!/usr/bin/env python3
"""I5: bounded restarts escalate once through Tier0 and once to the owner."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANAGER = HERE / "samantha-health-manager.sh"
NOTIFY = HERE / "incident-notify.sh"


class RestartEscalationTests(unittest.TestCase):
    def test_every_health_manager_restart_path_uses_the_same_gate(self):
        text = MANAGER.read_text()
        for snippet in (
            'restart_gate "$n" || return',
            'restart_gate adb || return',
            'restart_gate whatsapp || return',
            'restart_gate gateway_memory || return',
            'restart_gate sshd || return',
            'restart_gate slack_bridge || return',
        ):
            self.assertIn(snippet, text)

    def run_probe(self, body: str):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            runtime = home / "runtime"
            runtime.mkdir()
            notify = runtime / "incident-notify.sh"
            notify.write_text(f'#!/bin/sh\nexec bash "{NOTIFY}" "$@"\n')
            notify.chmod(0o700)
            orchestrator = runtime / "incident-orchestrator.py"
            orchestrator.write_text(
                "#!/bin/sh\n"
                "echo \"$*\" >>\"$HOME/orchestrator.calls\"\n"
                "[ \"$1\" = open ] && printf '%s\\n' '{\"id\":\"incident-one\",\"correlation_id\":\"probe-test-correlation\"}'\n"
            )
            orchestrator.chmod(0o700)
            close = runtime / "incident-close.sh"
            close.write_text("#!/bin/sh\nexit 0\n")
            close.chmod(0o700)
            tier0 = home / ".openclaw/tier0/bin"
            tier0.mkdir(parents=True)
            control = tier0 / "tier0-control.py"
            control.write_text("#!/bin/sh\necho \"$*\" >>\"$HOME/rollback.calls\"\nexit \"${ROLLBACK_RC:-0}\"\n")
            control.chmod(0o700)
            prefix = MANAGER.read_text().split("log 'event=start", 1)[0]
            probe = home / "probe.sh"
            probe.write_text(prefix + "\n" + body)
            env = dict(
                os.environ,
                HOME=str(home),
                CLAW_RUNTIME_ROOT=str(runtime),
                HEALTH_RESTART_BUDGET_N="2",
                HEALTH_RESTART_WINDOW_S="3600",
                HEALTH_STABILITY_RESET_S="600",
                HEALTH_ROLLBACK_GRACE_S="60",
            )
            result = subprocess.run(["bash", str(probe)], env=env, capture_output=True, text=True, timeout=20)
            files = {}
            for path in home.rglob("*"):
                if path.is_file():
                    try:
                        files[str(path.relative_to(home))] = path.read_text()
                    except UnicodeDecodeError:
                        pass
            return result, files

    def test_budget_then_one_rollback_then_one_human_required(self):
        result, files = self.run_probe(
            """
CLOCK=100; now(){ echo "$CLOCK"; }
restart_gate companion
restart_gate companion
if restart_gate companion; then exit 21; fi
[ "$(get companion escalation none)" = rolled_back ]
CLOCK=120; if restart_gate companion; then exit 22; fi
[ "$(get companion escalation none)" = rolled_back ]
CLOCK=161; if restart_gate companion; then exit 23; fi
[ "$(get companion escalation none)" = human_required ]
CLOCK=162; if restart_gate companion; then exit 24; fi
"""
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(files["rollback.calls"].count("rollback --reason health_restart_budget_exhausted:companion"), 1)
        self.assertEqual(files["orchestrator.calls"].count(" human_required "), 1)
        self.assertEqual(files[".openclaw/incidents/events.log"].count("event=queued"), 1)

    def test_failed_rollback_escalates_without_retrying_or_duplicating(self):
        result, files = self.run_probe(
            """
export ROLLBACK_RC=1
CLOCK=100; now(){ echo "$CLOCK"; }
restart_gate slack_bridge
restart_gate slack_bridge
if restart_gate slack_bridge; then exit 31; fi
if restart_gate slack_bridge; then exit 32; fi
"""
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(files["rollback.calls"].count("rollback --reason health_restart_budget_exhausted:slack_bridge"), 1)
        self.assertEqual(files["orchestrator.calls"].count(" human_required "), 1)
        self.assertEqual(files[".openclaw/incidents/events.log"].count("event=queued"), 1)

    def test_ten_stable_minutes_reset_backoff_and_budget(self):
        result, files = self.run_probe(
            """
CLOCK=100; now(){ echo "$CLOCK"; }
restart_gate companion
put companion failures 4
put companion status degraded
CLOCK=200; healthy companion
CLOCK=799; healthy companion
[ "$(get companion failures 0)" = 4 ]
[ -s "$(sf companion restart_attempts)" ]
CLOCK=800; healthy companion
[ "$(get companion failures 9)" = 0 ]
[ ! -e "$(sf companion restart_attempts)" ]
restart_gate companion
"""
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(files[".openclaw/health/state/companion.restart_attempts"], "800\n")

    def test_hourly_window_expires_old_attempts(self):
        result, files = self.run_probe(
            """
CLOCK=100; now(){ echo "$CLOCK"; }
restart_gate adb
CLOCK=101; restart_gate adb
CLOCK=3701; restart_gate adb
"""
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(files[".openclaw/health/state/adb.restart_attempts"], "3701\n")
        self.assertNotIn("rollback.calls", files)

    def test_identical_notification_is_not_requeued_after_acceptance(self):
        result, files = self.run_probe(
            """
"$ROOT/incident-notify.sh" human_required "same" "same action"
dir=$(find "$HOME/.openclaw/incidents/queue" -mindepth 1 -maxdepth 1 -type d | head -n1)
printf notified >"$dir/status"
"$ROOT/incident-notify.sh" human_required "same" "same action"
"""
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(files[".openclaw/incidents/events.log"].count("event=queued"), 1)
        status = [value for name, value in files.items() if name.endswith("/status")]
        self.assertEqual(status, ["notified"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
