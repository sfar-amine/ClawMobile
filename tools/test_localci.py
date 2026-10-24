#!/usr/bin/env python3
"""Offline fail-closed tests for canonical localci.py, including its S24 profile (synthetic, no device)."""
import contextlib
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import localci

class LocalCiUnitTests(unittest.TestCase):
    def test_android_failure_reports_survive_disposable_checkout_without_following_links(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            reports = root / "tree/android/samantha/app/build/test-results/testDebugUnitTest"
            reports.mkdir(parents=True)
            (reports / "TEST-failed.xml").write_text('<testsuite failures="1"><failure>fixture stack</failure></testsuite>')
            outside = root / "outside.xml"
            outside.write_text("not a test report")
            (reports / "TEST-link.xml").symlink_to(outside)
            artifacts = root / "proof"
            count, size, truncated = localci.preserve_app_test_reports(root / "tree", artifacts)
            shutil.rmtree(root / "tree")
            self.assertEqual(count, 1)
            self.assertGreater(size, 0)
            self.assertFalse(truncated)
            self.assertIn("fixture stack", (artifacts / "test-results/TEST-failed.xml").read_text())
            self.assertFalse((artifacts / "test-results/TEST-link.xml").exists())

    def test_sha_must_be_full(self):
        with self.assertRaisesRegex(localci.LocalCIError, "SHA"):
            localci.run_ci("samantha-core", "a" * 8, "-", "/dev/null")

    def test_s24_without_its_profile_is_refused_not_silently_allowed(self):
        with patch.dict(os.environ, {"PREFIX": "/data/data/com.termux/files/usr"}):
            os.environ.pop("LOCALCI_PROFILE", None)
            with self.assertRaisesRegex(localci.LocalCIError, "localci-s24.sh"):
                localci.run_ci("samantha-core", "a" * 40, "-", "/dev/null")

    def test_s24_profile_requires_the_heavy_job_lock(self):
        with patch.dict(os.environ, {"LOCALCI_PROFILE": "s24"}):
            os.environ.pop("LOCALCI_HEAVY_LOCK", None)
            with self.assertRaisesRegex(localci.LocalCIError, "LOCALCI_HEAVY_LOCK"):
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

    def s24(self, **extra):
        lock = Path(self.temp.name) / "companion-deploy.lock"
        env = {"LOCALCI_PROFILE": "s24", "LOCALCI_HEAVY_LOCK": str(lock), **extra}
        stack = contextlib.ExitStack()
        stack.enter_context(patch.dict(os.environ, env))
        real = shutil.which  # No gh on the S24: PR refs come from the wrapper's fetch.
        stack.enter_context(patch.object(localci.shutil, "which", lambda name: None if name == "gh" else real(name)))
        return lock, stack

    def pull_refs(self, pr, head):
        self.git("update-ref", f"refs/localci/pull/{pr}/head", head)
        merge = subprocess.run(["git", "-C", str(self.repo), "commit-tree", f"{head}^{{tree}}", "-p", self.base_sha,
                                "-p", head, "-m", "merge"], check=True, capture_output=True, text=True).stdout.strip()
        self.git("update-ref", f"refs/localci/pull/{pr}/merge", merge)

    def test_s24_profile_runs_with_private_home_no_credentials_and_wrapper_pr_refs(self):
        head = self.commit(
            "jobs:\n  contract:\n    steps:\n"
            "      - run: test \"$HOME\" != /live-home && test -d \"$HOME\"\n"
            "      - run: test -z \"${CLAW_TOKEN:-}${SAMANTHA_INTENT_INTERPRETER:-}${OPENCLAW_STATE:-}\"\n"
            "      - run: python3 -c 'import json,os; e=json.load(open(os.environ[\"GITHUB_EVENT_PATH\"])); "
            "assert e[\"pull_request\"][\"body\"]==\"## Résumé\\n\"'\n")
        self.pull_refs(7, head)
        body = Path(self.temp.name) / "body.md"
        body.write_text("## Résumé\n", encoding="utf-8")
        lock, env = self.s24(HOME="/live-home", CLAW_TOKEN="x", SAMANTHA_INTENT_INTERPRETER="1",
                             OPENCLAW_STATE="y", LOCALCI_PR_BODY_FILE=str(body))
        with env:
            self.assertEqual(localci.run_ci(str(self.repo), head, "7", str(self.log)), 0)
        output = self.log.read_text(encoding="utf-8")
        self.assertIn("profile=s24", output)
        self.assertIn(f"base={self.base_sha}", output)
        self.assertIn("LOCALCI_RESULT exit=0 sha=" + head, output)

    def test_s24_busy_lock_starts_nothing(self):
        import fcntl
        head = self.commit("jobs:\n  contract:\n    steps:\n      - run: echo no-effect\n")
        self.pull_refs(7, head)
        lock, env = self.s24()
        holder = os.open(lock, os.O_RDWR | os.O_CREAT)
        self.addCleanup(os.close, holder)
        fcntl.flock(holder, fcntl.LOCK_EX)  # A deploy or QA campaign holds it.
        with env, self.assertRaisesRegex(localci.LocalCIError, "heavy_job_busy"):
            localci.run_ci(str(self.repo), head, "7", str(self.log))
        self.assertFalse(self.log.exists())

    def test_s24_pr_head_mismatch_and_missing_refs_refused(self):
        head = self.commit("jobs:\n  contract:\n    steps:\n      - run: echo no-effect\n")
        lock, env = self.s24()
        with env, self.assertRaisesRegex(localci.LocalCIError, "S24 PR refs missing"):
            localci.run_ci(str(self.repo), head, "7", str(self.log))
        self.pull_refs(7, self.base_sha)
        lock, env = self.s24()
        with env, self.assertRaisesRegex(localci.LocalCIError, "GitHub PR head SHA mismatch"):
            localci.run_ci(str(self.repo), head, "7", str(self.log))
        self.assertFalse(self.log.exists())

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
        self.workflow.write_text("jobs: {apk: {steps: [{run: owner-is-not-reimplemented}]}}\n")
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

    def test_empty_or_extended_app_workflow_is_not_silently_ignored(self):
        for workflow,reason in (("jobs: {}", "Missing workflow jobs"),
                                ("jobs: {apk: {steps: []}}", "Unsupported Android"),
                                ("jobs: {apk: {steps: [{run: test}]}, added: {steps: [{run: additional}]}}", "Unsupported Android")):
            with self.subTest(workflow=workflow):
                self.workflow.write_text(workflow)
                self.git("add", ".")
                self.git("commit", "-qm", "workflow change")
                self.head=self.git("rev-parse", "HEAD")
                with self.assertRaisesRegex(localci.LocalCIError, reason):
                    self.run_owner()
        self.assertFalse(self.log.exists())

    def test_stale_artifacts_are_refused(self):
        self.log.with_name("out-android").mkdir()
        with self.assertRaisesRegex(localci.LocalCIError, "already exists"):
            self.run_owner()



class LocalCiPrivateProofTests(LocalCiSyntheticReplayTests):
    """Actual canonical owner on a tiny fake workflow; no full Samantha CI."""
    def setUp(self):
        super().setUp()
        import json
        self.subject = 'qualification/report.json'
        self.value = {'schema_version': 2, 'results': [{'id': 'synthetic-case', 'status': 'PASS'}]}
        target = self.repo/self.subject; target.parent.mkdir(); target.write_text(json.dumps(self.value))
        self.owner = self.repo.parent/'owner'; (self.owner/'tools').mkdir(parents=True)
        self.owner_file = self.owner/'tools/localci.py'
        self.owner_file.write_bytes(Path(localci.__file__).read_bytes())
        subprocess.run(['git', 'init', '-q', str(self.owner)], check=True)
        for args in (['config','user.name','Fixture'], ['config','user.email','fixture@example.invalid'],
                     ['add','.'], ['commit','-qm','canonical owner fixture']):
            subprocess.run(['git', '-C', str(self.owner), *args], check=True, capture_output=True)

    def qualify(self, body=None):
        head = self.commit(body or 'jobs:\n  contract:\n    steps:\n      - run: echo synthetic-short-workflow\n')
        with self.fake_gh(head), patch.object(localci, '__file__', str(self.owner_file)):
            proof = localci.run_ci_evidence(self.repo, head, '5', self.log, subject_path=self.subject, expected_subject_digest=self.subject_digest())
        return head, proof

    def subject_digest(self):
        import hashlib,json
        return hashlib.sha256(json.dumps(self.value, ensure_ascii=True, sort_keys=True, separators=(',',':')).encode()).hexdigest()

    def verify(self, head, proof):
        subject_digest = self.subject_digest()
        with self.fake_gh(head), patch.object(localci, '__file__', str(self.owner_file)):
            return localci.verify_ci_evidence(proof, repository='example/samantha-context-private', head=head,
                                             pr_number=5, subject_digest=subject_digest)

    def test_private_proof_from_real_short_workflow(self):
        head, proof = self.qualify()
        out = self.verify(head, proof)
        self.assertEqual(out['status'], 'PASS')
        self.assertEqual(out['base'], self.base_sha)
        self.assertEqual(len(out['runner_revision']), 40)
        self.assertEqual(out['proof_scope'], 'canonical_CI_and_committed_artifact_identity_only')

    def test_json_log_and_reconstructed_flags_cannot_create_proof(self):
        for value in (None, {'status':'PASS','exit_code':0,'executed':True}, 'LOCALCI_RESULT exit=0'):
            self.assertEqual(self.verify('a'*40, value)['status'], 'NOT_IMPLEMENTED')
        with self.assertRaises(localci.LocalCIError): localci.CanonicalCIProof({'exit_code':0})
        _, proof = self.qualify()
        import pickle
        with self.assertRaises(TypeError): pickle.dumps(proof)

    def test_false_success_marker_does_not_override_real_failure(self):
        with self.assertRaisesRegex(localci.LocalCIError, 'terminal_failure'):
            self.qualify('jobs:\n  contract:\n    steps:\n      - run: echo LOCALCI_RESULT exit=0; exit 17\n')

    def test_log_tamper_and_changed_subject_rejected(self):
        head, proof = self.qualify()
        self.log.write_text(self.log.read_text() + 'forged evidence')
        with self.assertRaisesRegex(localci.LocalCIError, 'artifact_or_owner_changed'):
            self.verify(head, proof)
        self.value = {'different':'subject'}
        with self.assertRaisesRegex(localci.LocalCIError, 'subject_binding_changed'):
            self.verify(head, proof)

    def test_pr_changed_after_run_refused(self):
        head = self.commit('jobs:\n  contract:\n    steps:\n      - run: echo short\n')
        original = localci._run_canonical_ci_process
        def changed(*args):
            out = original(*args)
            os.environ['MOCK_HEAD'] = 'f'*40
            return out
        with self.fake_gh(head), patch.object(localci, '__file__', str(self.owner_file)), patch.object(localci, '_run_canonical_ci_process', changed):
            with self.assertRaisesRegex(localci.LocalCIError, 'pr_identity_changed'):
                localci.run_ci_evidence(self.repo, head, '5', self.log, subject_path=self.subject, expected_subject_digest=self.subject_digest())

    def test_symlink_subject_and_reused_log_rejected_before_ci(self):
        target = self.repo/self.subject; target.unlink(); target.symlink_to('/outside-grant')
        head = self.commit('jobs:\n  contract:\n    steps:\n      - run: echo short\n')
        with self.fake_gh(head), self.assertRaisesRegex(localci.LocalCIError, 'regular_subject'):
            localci.run_ci_evidence(self.repo, head, '5', self.log, subject_path=self.subject, expected_subject_digest=self.subject_digest())
        self.assertFalse(self.log.exists())


    def test_subject_mismatch_and_stale_output_fail_before_execution(self):
        head = self.commit('jobs:\n  contract:\n    steps:\n      - run: echo must-not-start\n')
        with self.fake_gh(head), patch.object(localci, 'run_ci', side_effect=AssertionError('must not run')):
            with self.assertRaisesRegex(localci.LocalCIError, 'subject_binding_changed'):
                localci.run_ci_evidence(self.repo, head, '5', self.log, subject_path=self.subject, expected_subject_digest='0'*64)
        self.log.write_text('stale')
        with self.fake_gh(head), patch.object(localci, '__file__', str(self.owner_file)), patch.object(localci, 'run_ci', side_effect=AssertionError('must not run')):
            with self.assertRaisesRegex(localci.LocalCIError, 'fresh_output_required'):
                localci.run_ci_evidence(self.repo, head, '5', self.log, subject_path=self.subject, expected_subject_digest=self.subject_digest())

    def test_pr_changed_after_qualification_cannot_reuse_proof(self):
        head, proof = self.qualify()
        with self.fake_gh('f'*40), patch.object(localci, '__file__', str(self.owner_file)):
            with self.assertRaisesRegex(localci.LocalCIError, 'pr_identity_changed'):
                localci.verify_ci_evidence(proof, repository='example/samantha-context-private', head=head, pr_number=5, subject_digest=self.subject_digest())


    def test_import_then_committed_owner_change_refused_before_run(self):
        self.owner_file.write_text(self.owner_file.read_text() + '\n# newly committed source after import\n')
        subprocess.run(['git', '-C', str(self.owner), 'add', '.'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(self.owner), 'commit', '-qm', 'post-import owner change'], check=True, capture_output=True)
        head = self.commit('jobs:\n  contract:\n    steps:\n      - run: echo must-not-start\n')
        with self.fake_gh(head), patch.object(localci, '__file__', str(self.owner_file)), patch.object(localci, 'run_ci', side_effect=AssertionError('loaded source mismatch must not execute')):
            with self.assertRaisesRegex(localci.LocalCIError, 'loaded_owner_changed'):
                localci.run_ci_evidence(self.repo, head, '5', self.log, subject_path=self.subject, expected_subject_digest=self.subject_digest())
        self.assertFalse(self.log.exists())


    def test_detached_descendant_started_then_stopped_before_proof(self):
        import json, shlex, time
        started = self.repo.parent/'descendant-started'
        late = self.repo.parent/'descendant-survived'
        child = "import pathlib,time;pathlib.Path(%r).write_text('started');time.sleep(.8);pathlib.Path(%r).write_text('survived')" % (str(started), str(late))
        parent = "import subprocess,sys,time,pathlib;subprocess.Popen([sys.executable,'-c',%r],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);deadline=time.monotonic()+2\nwhile not pathlib.Path(%r).exists() and time.monotonic()<deadline: time.sleep(.01)\nassert pathlib.Path(%r).exists()" % (child, str(started), str(started))
        head, proof = self.qualify('jobs:\n  contract:\n    steps:\n      - run: ' + json.dumps('python3 -c ' + shlex.quote(parent)) + '\n')
        if proof is None:
            self.assertEqual(self.verify(head, proof)['status'], 'NOT_IMPLEMENTED'); return
        self.assertEqual(self.verify(head, proof)['status'], 'PASS')
        self.assertTrue(started.exists())
        time.sleep(1.1)
        self.assertFalse(late.exists(), 'a descendant must not survive proof issuance')

    def test_namespace_unavailable_has_no_uncontained_fallback(self):
        head = self.commit('jobs:\n  contract:\n    steps:\n      - run: echo must-not-start\n')
        with self.fake_gh(head), patch.object(localci, '__file__', str(self.owner_file)), patch.object(localci, '_canonical_pid_command', return_value=None), patch.object(localci, 'run_ci', side_effect=AssertionError('no uncontained run')):
            proof = localci.run_ci_evidence(self.repo, head, '5', self.log, subject_path=self.subject, expected_subject_digest=self.subject_digest())
        self.assertIsNone(proof)
        self.assertEqual(self.verify(head, proof)['status'], 'NOT_IMPLEMENTED')
        self.assertFalse(self.log.exists())

    def test_fifo_owner_refused_without_blocking_read(self):
        self.owner_file.unlink(); os.mkfifo(self.owner_file)
        head = self.commit('jobs:\n  contract:\n    steps:\n      - run: echo must-not-start\n')
        with self.fake_gh(head), patch.object(localci, '__file__', str(self.owner_file)), patch.object(localci, '_run_canonical_ci_process', side_effect=AssertionError('no run')):
            with self.assertRaisesRegex(ValueError, 'regular_bounded_owner_required'):
                localci.run_ci_evidence(self.repo, head, '5', self.log, subject_path=self.subject, expected_subject_digest=self.subject_digest())



class LocalCiS24GhTests(unittest.TestCase):
    """The S24 steps' `gh`: two read-only forms from local mirrors, anything else refused."""

    def setUp(self):
        import localci_s24_gh
        self.gh = localci_s24_gh
        self.temp = tempfile.TemporaryDirectory(prefix="ci-gh-")
        self.addCleanup(self.temp.cleanup)
        origin = Path(self.temp.name) / "origin"
        origin.mkdir()
        run = lambda repo, *a: subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True, text=True).stdout.strip()
        run(origin, "init", "-q", "-b", "runtime/x")
        run(origin, "config", "user.email", "f@example.invalid"); run(origin, "config", "user.name", "F")
        (origin / "tools").mkdir(); (origin / "tools" / "a.py").write_text("print('peer')\n")
        run(origin, "add", "."); run(origin, "commit", "-qm", "c")
        self.sha = run(origin, "rev-parse", "HEAD")
        mirrors = Path(self.temp.name) / "repos"
        subprocess.run(["git", "clone", "-q", str(origin), str(mirrors / "samantha-core")], check=True)
        self.env = patch.dict(os.environ, {"LOCALCI_S24_MIRRORS": str(mirrors)})
        self.env.start(); self.addCleanup(self.env.stop)
        self.gh.MIRRORS = mirrors

    def call(self, *argv):
        import io, contextlib as cl
        out = io.StringIO()
        with cl.redirect_stdout(out):
            code = self.gh.main(list(argv))
        return code, out.getvalue()

    def test_ref_and_contents_are_served_from_the_mirror(self):
        code, out = self.call("api", "repos/sfar-amine/samantha-core/git/ref/heads/runtime/x", "--jq", ".object.sha")
        self.assertEqual((code, out.strip()), (0, self.sha))
        code, out = self.call("api", f"repos/sfar-amine/samantha-core/contents/tools/a.py?ref={self.sha}", "--jq", ".content")
        import base64
        self.assertEqual(base64.b64decode(out), b"print('peer')\n")

    def test_anything_else_is_refused(self):
        for argv in (("pr", "view", "1"), ("api", "repos/sfar-amine/samantha-core/pulls/1"),
                     ("api", "repos/sfar-amine/other/git/ref/heads/main"),
                     ("api", f"repos/sfar-amine/samantha-core/contents/../x?ref={self.sha}"),
                     ("api", "repos/sfar-amine/samantha-core/git/ref/heads/runtime/x", "--jq", ".ref")):
            with self.assertRaises(SystemExit) as raised:
                self.call(*argv)
            self.assertEqual(raised.exception.code, 2)


class LocalCiS24LauncherTests(unittest.TestCase):
    """tools/localci-s24.sh: what Termux and Debian both touch keeps one absolute path; node is on the base PATH."""

    def setUp(self):
        self.text = (Path(__file__).resolve().parent / "localci-s24.sh").read_text()

    def test_no_debian_only_path_for_mirrors_worktrees_or_logs(self):
        self.assertIn('--bind "$ci:$ci"', self.text)
        self.assertIn('LOCALCI_TMP_ROOT="$ci/tmp"', self.text)
        self.assertNotRegex(self.text, r"(?<![\w$])/ci/")

    def test_base_path_has_node_like_the_github_runner_image(self):
        self.assertRegex(self.text, r"env -i PATH=/opt/node22/bin:")

if __name__ == "__main__":
    unittest.main()
