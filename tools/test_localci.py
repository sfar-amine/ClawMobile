#!/usr/bin/env python3
"""Offline fail-closed tests for canonical localci.py; never run on S24."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import localci

class LocalCiUnitTests(unittest.TestCase):
    def test_sha_must_be_full(self):
        with self.assertRaisesRegex(localci.LocalCIError, "SHA"):
            localci.run_ci("samantha-core", "a" * 8, "-", "/dev/null")

    def test_s24_is_forbidden(self):
        with patch.dict(os.environ, {"PREFIX": "/data/data/com.termux/files/usr"}):
            with self.assertRaisesRegex(localci.LocalCIError, "S24"):
                localci.run_ci("samantha-core", "a" * 40, "-", "/dev/null")

    def test_unsupported_expression_fails_closed(self):
        with self.assertRaisesRegex(localci.LocalCIError, "Unknown GitHub expression"):
            localci.expressions("$" + "{{ secrets.UNRELATED }}", {})

    def test_unsupported_condition_fails_closed(self):
        with self.assertRaisesRegex(localci.LocalCIError, "Unsupported if"):
            localci.conditional("contains(github.ref, 'main')", "55")

    def test_pr_condition_is_not_silently_ignored(self):
        self.assertTrue(localci.conditional("github.event_name == 'pull_request'", "55"))
        self.assertFalse(localci.conditional("github.event_name == 'pull_request'", "-"))

    def test_github_env_multiline_and_singleline(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "github-env"
            target.write_text("HELLO=world\nLONG<<EOF\nline1\nline2\nEOF\n", encoding="utf-8")
            values = {}
            localci.apply_github_env(target, values)
            self.assertEqual(values, {"HELLO": "world", "LONG": "line1\nline2"})
            self.assertEqual(target.read_text(encoding="utf-8"), "")

if __name__ == "__main__":
    unittest.main()
