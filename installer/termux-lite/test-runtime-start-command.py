#!/usr/bin/env python3
"""The gateway start command comes from the running root, never from a stale inherited release (S24 18/10 00:47)."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

LIB = Path(__file__).resolve().parent / "lib.sh"


def resolve(script_dir, inherited=None):
    env = {k: v for k, v in os.environ.items() if k != "CLAWMOBILE_RUNTIME_START_COMMAND"}
    if inherited is not None:
        env["CLAWMOBILE_RUNTIME_START_COMMAND"] = inherited
    out = subprocess.run(["bash", "-c", f'source "{LIB}"; clawmobile_runtime_start_command "$1"', "_", script_dir],
                         env=env, capture_output=True, text=True, check=True)
    return out.stdout.strip(), out.stderr


class RuntimeStartCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.own = os.path.join(self.temp.name, "ClawMobile", "installer", "termux-lite")

    def test_default_is_the_running_root(self):
        self.assertEqual(resolve(self.own)[0], self.own + "/gateway-start.sh")

    def test_a_pruned_release_inherited_through_the_bridge_is_ignored(self):
        stale = "/data/data/com.termux/files/home/.openclaw/releases/20261016T113233-d3beb769/termux-lite/gateway-start.sh"
        value, err = resolve(self.own, stale)
        self.assertEqual(value, self.own + "/gateway-start.sh")
        self.assertIn("runtime_start_command_inherited_ignored", err)

    def test_an_existing_older_release_is_ignored_too(self):
        older = os.path.join(self.temp.name, "releases", "old", "termux-lite")
        os.makedirs(older)
        script = Path(older, "gateway-start.sh")
        script.write_text("#!/bin/sh\n")
        script.chmod(0o755)
        self.assertEqual(resolve(self.own, str(script))[0], self.own + "/gateway-start.sh")

    def test_an_executable_operator_override_is_kept(self):
        custom = Path(self.temp.name, "my-gateway.sh")
        custom.write_text("#!/bin/sh\n")
        custom.chmod(0o755)
        self.assertEqual(resolve(self.own, str(custom))[0], str(custom))

    def test_a_missing_operator_override_falls_back_and_says_so(self):
        value, err = resolve(self.own, "/nowhere/my-gateway.sh")
        self.assertEqual(value, self.own + "/gateway-start.sh")
        self.assertIn("runtime_start_command_missing", err)

    def test_companion_server_uses_the_resolver(self):
        text = (LIB.parent / "companion-server.sh").read_text()
        self.assertIn('CLAWMOBILE_RUNTIME_START_COMMAND="$(clawmobile_runtime_start_command "$SCRIPT_DIR")"', text)
        self.assertNotIn("${CLAWMOBILE_RUNTIME_START_COMMAND:-", text)

    def test_the_deploy_lock_descriptor_does_not_outlive_the_deploy(self):
        # The Companion (and the Remote Bridge inside it) must not hand a dead lock fd to later commands.
        lines = [l.strip() for l in (LIB.parent / "companion-server.sh").read_text().splitlines()]
        self.assertIn("unset SAMANTHA_DEPLOY_LOCK_FD", lines)
        self.assertLess(lines.index("unset SAMANTHA_DEPLOY_LOCK_FD"), lines.index("cd \"$REPO_ROOT\""))


if __name__ == "__main__":
    unittest.main()
