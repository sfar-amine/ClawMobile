#!/usr/bin/env python3
"""R09: every Termux-lite test is either run by CI or explicitly platform-only."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
TEST_ROOT = ROOT / "installer" / "termux-lite"
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"

# These tests validate the real Termux executable tree and login-shell
# behavior. Replacing /data/data/com.termux here would stop testing their
# contract, so they remain in the on-device acceptance rather than Ubuntu CI.
PLATFORM_ONLY = {
    "test-openclaw-login-shell.sh": "requires the real Termux login bash and PREFIX tree",
    "test-termux-tmp-paths.sh": "requires the real Termux PREFIX and tmp-path semantics",
}


def active_run_commands(workflow: str) -> list[str]:
    """Return executable command lines from YAML run fields, without comments."""
    commands = []
    lines = workflow.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        match = re.match(r"^(\s*)run:\s*(.*)$", line)
        if not match:
            index += 1
            continue
        indent, value = len(match.group(1)), match.group(2).strip()
        if value and value not in {"|", ">", "|-", ">-"}:
            commands.append(value)
            index += 1
            continue
        index += 1
        while index < len(lines):
            candidate = lines[index]
            if candidate.strip() and len(candidate) - len(candidate.lstrip()) <= indent:
                break
            stripped = candidate.strip()
            if stripped and not stripped.startswith("#"):
                commands.append(stripped.split(" #", 1)[0].rstrip())
            index += 1
    return commands


def registered_tests(workflow: str) -> set[str]:
    registered = set()
    for command in active_run_commands(workflow):
        # A filename only counts after an explicit host interpreter. A step
        # title, YAML comment or shell comment cannot satisfy this contract.
        for name in re.findall(
            r"(?:^|[;&|]\s*)(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*"
            r"(?:python(?:3)?|node|bash|sh)\s+[^#;&|\n]*?(test-[A-Za-z0-9_.-]+)",
            command,
        ):
            registered.add(name)
    return registered


class CiRegistrationTests(unittest.TestCase):
    def test_every_test_is_registered_or_justified(self):
        workflow = WORKFLOW.read_text()
        tests = sorted(path.name for path in TEST_ROOT.glob("test-*") if path.is_file())
        registered = registered_tests(workflow)
        missing = [name for name in tests if name not in registered and name not in PLATFORM_ONLY]
        self.assertEqual(missing, [], "tests absent from ci.yml: " + ", ".join(missing))

    def test_comments_and_step_names_do_not_register_a_test(self):
        fake = """
      - name: python3 installer/termux-lite/test-fake.py
        # run: python3 installer/termux-lite/test-fake.py
        run: |
          # python3 installer/termux-lite/test-fake.py
          printf 'not a test' # python3 installer/termux-lite/test-fake.py
        """
        self.assertNotIn("test-fake.py", registered_tests(fake))

    def test_platform_only_exceptions_are_present_and_justified(self):
        for name, reason in PLATFORM_ONLY.items():
            with self.subTest(name=name):
                self.assertTrue((TEST_ROOT / name).is_file())
                self.assertGreaterEqual(len(reason.split()), 6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
