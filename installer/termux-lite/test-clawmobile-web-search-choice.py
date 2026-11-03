#!/usr/bin/env python3
"""configure_lite_defaults keeps an explicit web search provider (Codex Hosted Search, 03/11)."""

from pathlib import Path
import re
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "clawmobile"


def defaults_function() -> str:
    text = SCRIPT.read_text()
    match = re.search(r"^config_set_json\(\) \{.*?^\}\n", text, re.S | re.M)
    body = re.search(r"^configure_lite_defaults\(\) \{.*?^\}\n", text, re.S | re.M)
    assert match and body
    return match.group(0) + body.group(0)


def run(provider: str) -> list[str]:
    with tempfile.TemporaryDirectory() as root:
        log = Path(root) / "openclaw.log"
        script = f"""
set -euo pipefail
SCRIPT_DIR={root}
HOME={root}
openclaw() {{
  printf '%s\\n' "$*" >> {log}
  if [ "$1" = config ] && [ "$2" = get ]; then printf '%s\\n' '{provider}'; fi
  return 0
}}
{defaults_function()}
configure_lite_defaults
"""
        subprocess.run(["bash", "-c", script], check=True, capture_output=True, text=True)
        return log.read_text().splitlines()


class WebSearchChoiceTests(unittest.TestCase):
    def test_unset_provider_keeps_the_android_default(self):
        for value in ("", "null", "undefined"):
            calls = run(value)
            self.assertIn("config unset tools.web.search.provider", calls)
            self.assertTrue(any(c.startswith('config set plugins.entries["codex"].enabled false') for c in calls))

    def test_explicit_codex_choice_is_kept(self):
        calls = run('"codex"')
        self.assertNotIn("config unset tools.web.search.provider", calls)
        self.assertFalse(any("plugins.entries" in c and "codex" in c for c in calls))
        self.assertTrue(any(c.startswith("config set tools.web.search.enabled true") for c in calls))

    def test_any_explicit_provider_is_kept(self):
        calls = run("brave")
        self.assertNotIn("config unset tools.web.search.provider", calls)


if __name__ == "__main__":
    unittest.main()
