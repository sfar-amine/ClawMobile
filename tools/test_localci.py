#!/usr/bin/env python3
"""Offline fail-closed tests for canonical localci.py; never run on S24."""
import os
import shutil
import subprocess
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

class LocalCiSyntheticReplayTests(unittest.TestCase):
    """Use a disposable local Git repo and a fake gh; no network or private files."""

    def setUp(self):
        import subprocess
        self.temp = tempfile.TemporaryDirectory(prefix="ci-offline-")
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.repo = base / "samantha-context-private"
        self.repo.mkdir()
        def git(*args):
            return subprocess.run(["git", "-C", str(self.repo), *args],
                                  check=True, capture_output=True, text=True).stdout.strip()
        self.git = git
        git("init", "-q")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        git("remote", "add", "origin", "https://github.com/example/samantha-context-private.git")
        folder = self.repo / ".github" / "workflows"
        folder.mkdir(parents=True)
        workflow = folder / "context-contract.yml"
        workflow.write_text("jobs:\n  contract:\n    steps:\n      - run: echo baseline\n", encoding="utf-8")
        git("add", ".")
        git("commit", "-qm", "base")
        self.base_sha = git("rev-parse", "HEAD")
        self.workflow = workflow
        self.bin = base / "bin"
        self.bin.mkdir()
        executable = self.bin / "gh"
        executable.write_text(
            "#!/usr/bin/env python3\n"
            "import json,os,sys\n"
            "# REST only: GraphQL (gh pr view) is refused in agent containers.\n"
            "assert sys.argv[1:3]==['api','repos/example/samantha-context-private/pulls/5'], sys.argv\n"
            "print(json.dumps({'head':{'sha':os.environ['MOCK_HEAD']},"
            "'base':{'sha':os.environ['MOCK_BASE']},"
            "'body':'## Résumé\\n\\n## Vérification\\n','number':5}))\n",
            encoding="utf-8")
        executable.chmod(0o755)
        self.log = base / "out.log"

    def commit(self, body):
        self.workflow.write_text(body, encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-qm", "head")
        return self.git("rev-parse", "HEAD")

    def fake_gh(self, head):
        return patch.dict(os.environ, {"PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                                        "MOCK_HEAD": head, "MOCK_BASE": self.base_sha})

    def test_full_sequence_github_event_and_exact_sha(self):
        head = self.commit(
            "jobs:\n  contract:\n    steps:\n"
            "      - uses: actions/checkout@v4\n"
            "      - run: echo 'FLAG=confirmed' >> \"$GITHUB_ENV\"\n"
            "      - run: test \"$FLAG\" = confirmed\n"
            "      - run: python3 -c 'import json,os; e=json.load(open(os.environ[\"GITHUB_EVENT_PATH\"])); assert e[\"pull_request\"][\"number\"]==5'\n")
        with self.fake_gh(head):
            self.assertEqual(localci.run_ci(str(self.repo), head, "5", str(self.log)), 0)
        output = self.log.read_text(encoding="utf-8")
        self.assertIn("LOCALCI_RESULT exit=0 sha=" + head, output)
        self.assertEqual(output.count("STEP_END "), 4)
        self.assertEqual(len(self.git("worktree", "list").splitlines()), 1)

    def test_sha_mismatch_refused_before_work(self):
        head = self.commit("jobs:\n  contract:\n    steps:\n      - run: echo no-effect\n")
        with self.fake_gh("f" * 40):
            with self.assertRaisesRegex(localci.LocalCIError, "GitHub PR head SHA mismatch"):
                localci.run_ci(str(self.repo), head, "5", str(self.log))
        self.assertFalse(self.log.exists())

    def test_versioned_python_gets_a_setup_python_shim(self):
        # Stock images often ship python3 = another minor version and python3.12 beside it.
        folder = localci.bin_for("python", "3.12") if shutil.which("python3.12") else None
        if folder is None:
            self.skipTest("python3.12 absent")
        for name in ("python", "python3"):
            out = subprocess.run([str(Path(folder) / name), "-c", "import sys;print(sys.version_info[:2])"],
                                 capture_output=True, text=True).stdout.strip()
            self.assertEqual(out, "(3, 12)")

    def test_exit_failure_aborts_remaining_commands(self):
        head = self.commit("jobs:\n  contract:\n    steps:\n"
                           "      - run: exit 17\n"
                           "      - run: echo FORBIDDEN_NEXT\n")
        with self.fake_gh(head):
            self.assertEqual(localci.run_ci(str(self.repo), head, "5", str(self.log)), 17)
        self.assertNotIn("FORBIDDEN_NEXT", self.log.read_text(encoding="utf-8"))
        self.assertEqual(len(self.git("worktree", "list").splitlines()), 1)


if __name__ == "__main__":
    unittest.main()
