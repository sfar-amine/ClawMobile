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

    def test_versioned_python_gets_a_setup_python_environment(self):
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


class LocalCiAndroidReplayTests(unittest.TestCase):
    """The real CLI delegates a versioned fake owner; no SDK, network or signing key."""
    fake_gh = LocalCiSyntheticReplayTests.fake_gh

    def setUp(self):
        LocalCiSyntheticReplayTests.setUp(self)
        original = self.repo
        self.repo = original.with_name("samantha-core")
        original.rename(self.repo)
        self.git("remote", "set-url", "origin", "https://github.com/example/samantha-core.git")
        gh = self.bin / "gh"
        gh.write_text(gh.read_text().replace("samantha-context-private", "samantha-core"))
        self.workflow = self.repo / localci.APP_WORKFLOW
        self.workflow.write_text("jobs: {android: {steps: [{run: owner-is-not-reimplemented}]}}\n")
        owner = self.repo / localci.APP_BUILDER
        owner.parent.mkdir(parents=True)
        owner.write_text("""#!/bin/bash
set -eu
[ "$#" = 2 ] && [ "$1" = --out ]
[ -z "${SAMANTHA_DEBUG_KEYSTORE+x}" ]
[ -z "$(git status --porcelain --untracked-files=no)" ]
python3 - "$2" <<'PYOWNER'
import hashlib,json,os,pathlib,subprocess,sys
folder=pathlib.Path(sys.argv[1]);folder.mkdir()
mode=os.getenv('MOCK_ANDROID_MODE','good')
if mode=='exit':sys.exit(23)
sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
apk=b'APK fixture, not installable';digest=hashlib.sha256(apk).hexdigest()
(folder/'app-optimized.apk').write_bytes(apk)
(folder/'app-optimized.apk.sha256').write_text(digest+'  app-optimized.apk\\n')
tests={'suites':2,'tests':7,'failures':0,'errors':0,'skipped':0}
r={'version':1,'commit':sha,'apk':'app-optimized.apk','sha256':digest,
   'command':['versioned owner command'],
   'versions':{'jdk':'21','agp':'8.13','build_tools':'36.0.0','platform':'android-36'},'tests':tests}
if mode=='sha':r['commit']='f'*40
if mode in ('failures','errors','skipped'):tests[mode]=1
if mode=='empty':tests['tests']=0
if mode=='boolean':tests['tests']=True
if mode=='checksum':r['sha256']='0'*64
if mode=='versions':r['versions']['jdk']=None
if mode=='restore':pathlib.Path('tracked-dirty').write_text('changed')
if mode=='malformed':(folder/'build.json').write_text('{')
elif mode!='missing':(folder/'build.json').write_text(json.dumps(r))
PYOWNER
""")
        (self.repo / "tracked-dirty").write_text("original")
        self.git("add", ".")
        self.git("commit", "-qm", "versioned Android owner")
        self.head = self.git("rev-parse", "HEAD")

    def run_owner(self, mode="good"):
        with self.fake_gh(self.head), patch.dict(os.environ, {
            "MOCK_ANDROID_MODE": mode, "SAMANTHA_DEBUG_KEYSTORE": "must-not-reach-owner"}):
            return localci.run_ci(str(self.repo), self.head, "5", str(self.log))

    def test_exact_head_delegation_preserves_evidence_and_no_key_or_publish(self):
        self.assertEqual(self.run_owner(), 0)
        output = self.log.read_text()
        self.assertIn("tests=7 failures=0 errors=0 skipped=0", output)
        self.assertIn("LOCALCI_RESULT exit=0 sha=" + self.head, output)
        self.assertTrue(self.log.with_name("out-android").joinpath("build.json").is_file())
        self.assertEqual(len(self.git("worktree", "list").splitlines()), 1)

    def test_invalid_receipts_fail_closed(self):
        for mode in ("sha", "failures", "errors", "skipped", "empty", "boolean", "checksum", "versions", "malformed", "missing"):
            with self.subTest(mode=mode):
                self.log = self.log.with_name(mode + ".log")
                with self.assertRaisesRegex(localci.LocalCIError, "android_receipt_invalid"):
                    self.run_owner(mode)
                self.assertEqual(len(self.git("worktree", "list").splitlines()), 1)

    def test_owner_exit_is_propagated(self):
        self.assertEqual(self.run_owner("exit"), 23)

    def test_dirty_owner_is_refused(self):
        with self.assertRaisesRegex(localci.LocalCIError, "restore"):
            self.run_owner("restore")

    def test_pr_head_mismatch_prevents_owner_execution(self):
        with self.fake_gh("f" * 40):
            with self.assertRaisesRegex(localci.LocalCIError, "head SHA mismatch"):
                localci.run_ci(str(self.repo), self.head, "5", str(self.log))
        self.assertFalse(self.log.exists())

    def test_disk_preflight_prevents_owner_execution_without_cleaning(self):
        sentinel = self.repo / "preserve-me"
        sentinel.write_text("caller data")
        from collections import namedtuple
        usage = namedtuple("Usage", "total used free")
        with self.fake_gh(self.head), patch.object(localci.shutil, "disk_usage", return_value=usage(10, 9, 1)):
            with self.assertRaisesRegex(localci.LocalCIError, "disk_space_insufficient"):
                localci.run_ci(str(self.repo), self.head, "5", str(self.log))
        self.assertEqual(sentinel.read_text(), "caller data")
        self.assertFalse(self.log.exists())

    def test_missing_versioned_owner_is_refused(self):
        (self.repo / localci.APP_BUILDER).unlink()
        self.git("add", ".")
        self.git("commit", "-qm", "owner missing")
        self.head = self.git("rev-parse", "HEAD")
        with self.assertRaisesRegex(localci.LocalCIError, "Missing versioned Android"):
            self.run_owner()
        self.assertFalse(self.log.exists())

    def test_stale_artifacts_are_refused(self):
        self.log.with_name("out-android").mkdir()
        with self.assertRaisesRegex(localci.LocalCIError, "already exists"):
            self.run_owner()


if __name__ == "__main__":
    unittest.main()
