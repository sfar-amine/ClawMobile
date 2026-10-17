#!/data/data/com.termux/files/usr/bin/python3
"""companion-deploy.sh resolves the checkout, never an inherited Tier0 release.

Regression guard for the S24 incident of 17/10 18:57. tier0-bootstrap.sh exports
CLAW_RUNTIME_ROOT at the Tier0 release it pinned, by design, and every process it starts
inherits it -- Gateway, plugin and Claw bridge included. companion-deploy.sh used to honour
that value unconditionally, so a deploy launched through the bridge resolved REPO inside a
release copy, which is not a git checkout, and died on `fetch_failed` with nothing to point
at. The release in that inherited value had since been pruned, so the trap was silent.

These tests fail if the unconditional override comes back.
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEPLOY = ROOT / "companion-deploy.sh"
REPO = ROOT.parent.parent


def resolve(env_overrides):
    env = dict(os.environ)
    env.pop("CLAW_RUNTIME_ROOT", None)
    env.update(env_overrides)
    out = subprocess.run(
        ["bash", str(DEPLOY), "--resolve"],
        capture_output=True, text=True, env=env, timeout=30,
    )
    return out


class CompanionDeployRootTests(unittest.TestCase):
    def test_resolves_checkout_without_override(self):
        out = resolve({})
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout)["repo"], str(REPO))

    def test_ignores_inherited_release_root(self):
        """The exact shape of the incident: a release copy with no repository above it."""
        with tempfile.TemporaryDirectory() as tmp:
            release = Path(tmp) / "20261016T113233-d3beb769" / "termux-lite"
            release.mkdir(parents=True)
            shutil.copy2(DEPLOY, release / "companion-deploy.sh")
            out = resolve({"CLAW_RUNTIME_ROOT": str(release)})
            self.assertEqual(out.returncode, 0, out.stderr)
            resolved = json.loads(out.stdout)["repo"]
            self.assertEqual(resolved, str(REPO))
            self.assertNotIn(tmp, resolved)

    def test_honours_override_that_carries_a_checkout(self):
        """A genuine second checkout is still respected: the fallback is not a hard pin."""
        with tempfile.TemporaryDirectory() as tmp:
            other = Path(tmp) / "ClawMobile"
            runtime = other / "installer" / "termux-lite"
            runtime.mkdir(parents=True)
            (other / ".git").mkdir()
            out = resolve({"CLAW_RUNTIME_ROOT": str(runtime)})
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertEqual(json.loads(out.stdout)["repo"], str(other))

    def test_refuses_clearly_when_no_checkout_can_be_found(self):
        """Run from a release copy with no override: fail closed, not `fetch_failed`."""
        with tempfile.TemporaryDirectory() as tmp:
            release = Path(tmp) / "release" / "termux-lite"
            release.mkdir(parents=True)
            copied = release / "companion-deploy.sh"
            shutil.copy2(DEPLOY, copied)
            env = dict(os.environ)
            env.pop("CLAW_RUNTIME_ROOT", None)
            out = subprocess.run(
                ["bash", str(copied), "--resolve"],
                capture_output=True, text=True, env=env, timeout=30,
            )
            self.assertEqual(out.returncode, 2, out.stdout)
            self.assertIn("deploy_requires_checkout", out.stderr)

    def test_tier0_bootstrap_still_exports_the_runtime_root(self):
        """The export is deliberate: Tier0 daemons must run the pinned release.

        The fix belongs to the consumer, so this asserts the Tier0 contract is untouched.
        """
        self.assertIn(
            'export CLAW_RUNTIME_ROOT="$ROOT"',
            (ROOT / "tier0-bootstrap.sh").read_text(),
        )


if __name__ == "__main__":
    unittest.main()
