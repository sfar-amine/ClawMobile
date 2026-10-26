#!/usr/bin/env python3
"""Single owner of local CI for all Samantha repositories, off-phone or on the S24.

Usage: python3 samantha-core/tools/localci.py <repo> <40-char-head-sha> <PR|-> <log>
Requires PyYAML, git, bash, gh (for PRs) and workflow-declared toolchains.
Overrides: LOCALCI_NODE20_BIN, LOCALCI_NODE22_BIN, LOCALCI_NODE26_BIN,
LOCALCI_PYTHON312_BIN; each specifies a toolchain bin directory.
On the S24 it runs through tools/localci-s24.sh (profile `s24`, Amine 24/10: no PC dependency):
Debian toolchains, the deploy lock held exclusively (one heavy job at a time), low priority,
steps with a private HOME and no Samantha credentials in their environment.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import yaml

def _proof_regular_bytes(path, limit=128*1024):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError('canonical_ci_regular_bounded_owner_required')
        value = stream.read(limit + 1)
        if len(value) > limit:
            raise ValueError('canonical_ci_owner_budget_exceeded')
        return value

# Import-time identity: disk/HEAD moving later cannot relabel loaded code.
_LOADED_RUNNER_SHA256 = hashlib.sha256(_proof_regular_bytes(__file__)).hexdigest()

WORKFLOWS = {
    "samantha-core": ".github/workflows/ci.yml",
    "samantha-ui-playbooks": ".github/workflows/documentation.yml",
    "samantha-context-private": ".github/workflows/context-contract.yml",
}
SHA = re.compile(r"^[0-9a-f]{40}$")
EXPR = re.compile(r"\$\{\{\s*(.*?)\s*\}\}")


class LocalCIError(Exception):
    pass


# Runtime credentials and live-service switches never reach a CI step on the S24.
# Runtime credentials and service state, plus this run's own S24 controls: a step (localci's own tests
# included) sees what an ubuntu-latest step sees, never the outer run's profile or held lock.
S24_STEP_ENV_DROP = re.compile(r"^(CLAW_|SAMANTHA_|OPENCLAW_|COMPANION_|GH_|GITHUB_TOKEN$|OPENAI_|GEMINI_|GOOGLE_|ANTHROPIC_"
                               r"|LOCALCI_PROFILE$|LOCALCI_HEAVY_LOCK$|LOCALCI_PR_BODY_FILE$)")


def s24_profile():
    """True on the S24 profile. Termux without the profile is refused, never silently allowed."""
    termux = "/com.termux/" in str(Path.home()) or os.getenv("PREFIX", "").startswith("/data/data/com.termux")
    profile = os.getenv("LOCALCI_PROFILE") == "s24"
    if termux and not profile:
        raise LocalCIError("S24 detected: run through tools/localci-s24.sh (S24 profile: Debian toolchains, "
                           "one heavy job at a time, private HOME)")
    return profile


def s24_heavy_lock():
    """The deploy lock, held exclusively: no deploy, QA campaign or second CI runs meanwhile."""
    path = os.getenv("LOCALCI_HEAVY_LOCK")
    if not path:
        raise LocalCIError("S24 profile requires LOCALCI_HEAVY_LOCK (the companion deploy lock)")
    import fcntl
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise LocalCIError(f"heavy_job_busy: a deploy, QA campaign or CI holds {path}; nothing started") from None
    return fd


def s24_pr_refs(repo, pr):
    """PR head/base fetched by the S24 wrapper just before (refs/pull/N/{head,merge}), body from a file."""
    try:
        head = command(["git", "rev-parse", "--verify", f"refs/localci/pull/{pr}/head^{{commit}}"], repo)
        base = command(["git", "rev-parse", "--verify", f"refs/localci/pull/{pr}/merge^1"], repo)
    except LocalCIError:
        raise LocalCIError("S24 PR refs missing: tools/localci-s24.sh fetches refs/pull/N/head and "
                           "refs/pull/N/merge (a conflicting PR has no merge ref)") from None
    body_file = os.getenv("LOCALCI_PR_BODY_FILE")
    body = Path(body_file).read_text(encoding="utf-8") if body_file else ""
    return {"headRefOid": head, "baseRefOid": base, "body": body, "number": int(pr)}


def command(args, cwd):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if result.returncode:
        raise LocalCIError(f"Command failed: {args[:3]}: exit {result.returncode}; {result.stderr[:300]}")
    return result.stdout.strip()


def identity(repo):
    url = command(["git", "remote", "get-url", "origin"], repo)
    match = re.search(r"github\.com[:/]([^/\s:]+)/([^/\s]+?)(?:\.git)?$", url)
    if not match:
        raise LocalCIError("GitHub origin required for PR verification")
    return match.group(1) + "/" + match.group(2).removesuffix(".git")


def expressions(value, context):
    def repl(match):
        expression = match.group(1)
        for key in expression.split("||"):
            if context.get(key.strip()):
                return context[key.strip()]
        raise LocalCIError(f"Unknown GitHub expression: {expression}")
    return EXPR.sub(repl, str(value))


def conditional(value, pr):
    if value is None or value in ("always()", "success()", True):
        return True
    if value is False:
        return False
    if str(value).strip().strip("$" + "{").strip("}").strip() == "github.event_name == 'pull_request'":
        return pr != "-"
    raise LocalCIError(f"Unsupported if expression: {value}")


def bin_for(kind, version):
    label = str(version).replace(".", "")
    var = f"LOCALCI_{kind.upper()}{label}_BIN"
    configured = os.getenv(var)
    fallback = Path(f"/opt/node{version}/bin") if kind == "node" and version in (20, 22) else None
    # A versioned interpreter (python3.12) is accepted too: on a stock image `python3` is often another minor version.
    binaries = ["node"] if kind == "node" else ["python3", f"python{version}"]
    paths = [Path(configured).expanduser()] if configured else ([fallback] if fallback else [])
    for binary in binaries:
        paths.append(Path(shutil.which(binary) or "/not-found").parent)
    candidates = []
    for path in paths:
        folder = path if path.is_dir() else path.parent
        candidates += [folder / binary for binary in binaries]
    for executable in candidates:
        folder = executable.parent
        if not executable.is_file():
            continue
        probe = subprocess.run(
            [str(executable), "-p", "process.versions.node.split('.')[0]"] if kind == "node"
            else [str(executable), "-c", "import sys; print('%s.%s'%sys.version_info[:2])"],
            capture_output=True, text=True)
        if probe.returncode == 0 and probe.stdout.strip() == str(version):
            if kind == "node":
                return str(folder)
            # Like actions/setup-python: a private interpreter where `python`, `python3` and `pip install` work
            # (a distribution's system Python refuses pip installs, PEP 668).
            venv = Path(tempfile.mkdtemp(prefix="localci-python-", dir=os.getenv("LOCALCI_TMP_ROOT") or None))
            created = subprocess.run([str(executable), "-m", "venv", str(venv)], capture_output=True, text=True)
            if created.returncode or not (venv / "bin" / "python").is_file():
                raise LocalCIError(f"Cannot create a Python {version} environment: {created.stderr[:200]}")
            return str(venv / "bin")
    raise LocalCIError(f"Missing {kind} {version}: configure {var}; no CI step may be skipped")


def apply_github_env(path, env):
    if not path.exists():
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    at = 0
    while at < len(lines):
        item = lines[at]
        at += 1
        if not item:
            continue
        if "<<" in item:
            key, marker = item.split("<<", 1)
            value = []
            while at < len(lines) and lines[at] != marker:
                value.append(lines[at])
                at += 1
            if at >= len(lines):
                raise LocalCIError("Unclosed GITHUB_ENV entry")
            at += 1
            val = "\n".join(value)
        else:
            if "=" not in item:
                raise LocalCIError("Invalid GITHUB_ENV entry")
            key, val = item.split("=", 1)
        if not re.fullmatch(r"[a-zA-Z_][a-zA-Z_0-9]*", key):
            raise LocalCIError("Invalid GITHUB_ENV name")
        env[key] = val
    path.write_text("", encoding="utf-8")


APP_WORKFLOW = ".github/workflows/android-app.yml"
APP_BUILDER = "android/samantha/tools/build-apk-offphone.sh"


def disk_preflight(paths, app=False):
    """A conservative floor, not a build-space promise; never delete caller data."""
    minimum = (2 if app else 1) * 1024 ** 3
    for path in paths:
        folder = Path(path).resolve()
        while not folder.exists():
            folder = folder.parent
        free = shutil.disk_usage(folder).free
        if free < minimum:
            raise LocalCIError(f"disk_space_insufficient path={folder} free_bytes={free} minimum_bytes={minimum}")


def app_receipt(folder, sha):
    """Judge the existing Android owner's evidence without duplicating its steps."""
    try:
        receipt = json.loads((folder / "build.json").read_text(encoding="utf-8"))
        tests = receipt["tests"]
        valid_count = lambda value: type(value) is int and value >= 0
        if receipt.get("version") != 1 or receipt.get("commit") != sha:
            raise ValueError("receipt commit/version mismatch")
        if not all(valid_count(tests.get(k)) for k in ("suites", "tests", "failures", "errors", "skipped")):
            raise ValueError("invalid test counters")
        if tests["suites"] < 1 or tests["tests"] < 1 or any(tests[k] for k in ("failures", "errors", "skipped")):
            raise ValueError("tests missing, failed or skipped")
        if receipt.get("apk") != "app-optimized.apk":
            raise ValueError("unexpected APK filename")
        apk = folder / "app-optimized.apk"
        digest = hashlib.sha256(apk.read_bytes()).hexdigest()
        checksum = (folder / "app-optimized.apk.sha256").read_text(encoding="utf-8").split()
        if apk.stat().st_size < 1 or receipt.get("sha256") != digest or checksum != [digest, "app-optimized.apk"]:
            raise ValueError("APK checksum mismatch")
        if not isinstance(receipt.get("command"), list) or not receipt["command"]:
            raise ValueError("missing owner commands")
        versions = receipt.get("versions") or {}
        if not all(isinstance(versions.get(k), str) and versions[k].strip()
                   for k in ("jdk", "agp", "build_tools", "platform")):
            raise ValueError("missing toolchain versions")
        return tests
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        raise LocalCIError(f"android_receipt_invalid: {exc}") from exc


def preserve_app_test_reports(space, artifacts):
    """Keep bounded failure evidence before the disposable checkout is removed."""
    source = space / "android/samantha/app/build/test-results/testDebugUnitTest"
    count = size = 0
    truncated = False
    for report in sorted(source.glob("TEST-*.xml")):
        if report.is_symlink() or not report.is_file():
            continue
        length = report.stat().st_size
        if count >= 256 or length > 1024 * 1024 or size + length > 8 * 1024 * 1024:
            truncated = True
            break
        destination = artifacts / "test-results"
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(report, destination / report.name)
        count += 1
        size += length
    return count, size, truncated


def run_app_ci(repo, sha, pr, base, logpath, delivery=None):
    artifacts = logpath.with_name(logpath.stem + "-android")
    if artifacts.exists():
        raise LocalCIError("Android artifact directory already exists; use a new output log to avoid stale evidence")
    space = Path(tempfile.mkdtemp(prefix="localci-samantha-android-",
                                 dir=os.getenv("LOCALCI_TMP_ROOT") or None)).resolve()
    attached = False
    try:
        command(["git", "worktree", "add", "--detach", str(space), sha], repo)
        attached = True
        with logpath.open("w", encoding="utf-8", buffering=1) as log:
            def note(value):
                print(value, file=log, flush=True)
                print(value, flush=True)
            note(f"LOCALCI_START repo={repo.name} sha={sha} pr={pr} base={base} jobs=1 delivery=android")
            if delivery:
                note("DELIVERY_CONTRACT " + json.dumps(delivery, sort_keys=True))
            note(f"ANDROID_OWNER {APP_BUILDER} publication=not_requested signing=local_debug artifacts={artifacts}")
            env = dict(os.environ)
            env.pop("SAMANTHA_DEBUG_KEYSTORE", None)
            env.update({"CI": "true", "GITHUB_SHA": sha})
            proc = subprocess.Popen(["bash", str(space / APP_BUILDER), "--out", str(artifacts)],
                                    cwd=space, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, errors="replace")
            for line in proc.stdout:
                log.write(line)
            result = proc.wait()
            proc.stdout.close()
            count, size, truncated = preserve_app_test_reports(space, artifacts)
            note(f"ANDROID_TEST_REPORTS files={count} bytes={size} truncated={str(truncated).lower()} path={artifacts / 'test-results'}")
            if result:
                note(f"LOCALCI_RESULT exit={result} sha={sha} job=android owner=build-apk-offphone")
                return result
            if command(["git", "status", "--porcelain", "--untracked-files=no"], space):
                raise LocalCIError("Android owner did not restore the tracked checkout")
            tests = app_receipt(artifacts, sha)
            note(f"ANDROID_TESTS suites={tests['suites']} tests={tests['tests']} failures=0 errors=0 skipped=0")
            note(f"LOCALCI_RESULT exit=0 sha={sha} jobs=1 steps=1 tests={tests['tests']} delivery=android")
        return 0
    finally:
        if attached:
            subprocess.run(["git", "worktree", "remove", "--force", str(space)], cwd=repo, capture_output=True)
        shutil.rmtree(space, ignore_errors=True)


def run_ci(repo_arg, sha, pr, output):
    if not SHA.fullmatch(sha):
        raise LocalCIError("Full exact 40-character head SHA required")
    s24 = s24_profile()
    lock = s24_heavy_lock() if s24 else None
    try:
        if s24:
            try:
                os.nice(10)  # The live assistant keeps the CPU first.
            except OSError:
                pass
        return _run_ci(repo_arg, sha, pr, output, s24)
    finally:
        if lock is not None:
            os.close(lock)



# Single schema owner: immutable full PB tree, never a client-selected validator.
DELIVERY_OWNER_URL = "https://github.com/sfar-amine/samantha-ui-playbooks.git"
DELIVERY_OWNER_SHA = "698322f70d454151b802e3c5850db82f4a38d046"

def _checkout_delivery_owner(folder):
    command(["git", "init", "-q", str(folder)], folder.parent)
    command(["git", "remote", "add", "origin", DELIVERY_OWNER_URL], folder)
    command(["git", "fetch", "--quiet", "--depth", "1", "origin", DELIVERY_OWNER_SHA], folder)
    if command(["git", "rev-parse", "FETCH_HEAD"], folder) != DELIVERY_OWNER_SHA:
        raise LocalCIError("delivery_owner_revision_mismatch")
    command(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], folder)


def _validate_at_delivery_owner(owner, repo, base, head):
    # -I excludes the PR checkout and ambient PYTHONPATH; the original PB API
    # imports its own agent_runner/stdlib dependencies from the complete pin.
    program = r"""
import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from skill_intelligence.delivery_contract import validate_range,validate_note,changed_files,read_at
repo=Path(sys.argv[2]);base,head=sys.argv[3:5]
try:
    result=validate_range(repo,base,head)
    available=changed_files(repo,base,head)
    for path in result['notes']:
        note=json.loads(read_at(repo,head,path))
        validate_note(note,available,lambda p:read_at(repo,head,p),require_v2=True)
    print(json.dumps({'ok':True,'notes':result['notes']}))
except Exception as error:
    print(json.dumps({'ok':False,'reason':str(error)[:300]}));sys.exit(1)
"""
    result = subprocess.run([sys.executable, "-I", "-B", "-c", program,
                             str(owner), str(repo), base, head],
                            capture_output=True, text=True, timeout=90)
    try:
        value = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise LocalCIError("delivery_owner_validation_unavailable") from None
    if result.returncode or value.get("ok") is not True:
        raise LocalCIError("delivery_contract_v2:" + str(value.get("reason", "unavailable"))[:300])
    return {"owner": DELIVERY_OWNER_URL, "revision": DELIVERY_OWNER_SHA,
            "strict_v2": True, "notes": value["notes"]}


def validate_core_delivery(repo, base, head):
    with tempfile.TemporaryDirectory(prefix="localci-delivery-", dir=os.getenv("LOCALCI_TMP_ROOT") or None) as root:
        owner = Path(root) / "samantha-ui-playbooks"
        _checkout_delivery_owner(owner)
        return _validate_at_delivery_owner(owner, repo, base, head)


def _run_ci(repo_arg, sha, pr, output, s24=False):
    repo = Path(repo_arg).expanduser().resolve()
    if repo.name not in WORKFLOWS or not (repo / ".git").exists():
        raise LocalCIError("Expected one of three local Samantha repository checkouts")
    if command(["git", "cat-file", "-t", sha], repo) != "commit":
        raise LocalCIError("Fetch exact GitHub SHA before running")
    if pr != "-":
        if not pr.isdecimal() or not (shutil.which("gh") or s24):
            raise LocalCIError("gh CLI and numeric PR required to verify exact head")
        if shutil.which("gh"):
            # REST, not GraphQL: `gh pr view` is refused in agent containers (HTTP 403, 17/10).
            raw = json.loads(command(["gh", "api", f"repos/{identity(repo)}/pulls/{pr}"], repo))
            refs = {"headRefOid": (raw.get("head") or {}).get("sha"), "baseRefOid": (raw.get("base") or {}).get("sha"),
                    "body": raw.get("body") or "", "number": raw.get("number")}
        else:
            refs = s24_pr_refs(repo, pr)
        if refs.get("headRefOid") != sha or not SHA.fullmatch(refs.get("baseRefOid") or ""):
            raise LocalCIError("GitHub PR head SHA mismatch")
        base = refs["baseRefOid"]
        if command(["git", "cat-file", "-t", base], repo) != "commit":
            raise LocalCIError("Fetch the exact GitHub PR base before running")
    else:
        refs = {}
        base = command(["git", "rev-parse", sha + "^"], repo)
    path = WORKFLOWS[repo.name]
    tracked = set(command(["git", "ls-tree", "-r", "--name-only", sha], repo).splitlines())
    app = repo.name == "samantha-core" and path not in tracked and APP_WORKFLOW in tracked
    if app:
        if APP_BUILDER not in tracked:
            raise LocalCIError("Missing versioned Android build owner")
        path = APP_WORKFLOW
    logpath = Path(output).expanduser().resolve()
    disk_preflight([os.getenv("LOCALCI_TMP_ROOT") or tempfile.gettempdir(), logpath.parent], app=app)
    logpath.parent.mkdir(parents=True, exist_ok=True)
    workflow = yaml.safe_load(command(["git", "show", f"{sha}:{path}"], repo))
    jobs = workflow.get("jobs") if isinstance(workflow, dict) else None
    if not isinstance(jobs, dict) or not jobs:
        raise LocalCIError("Missing workflow jobs")
    if app:
        if set(jobs) != {"apk"} or not isinstance(jobs["apk"], dict) or not jobs["apk"].get("steps"):
            raise LocalCIError("Unsupported Android workflow job layout; update the versioned build owner contract")
        delivery = validate_core_delivery(repo, base, sha)
        return run_app_ci(repo, sha, pr, base, logpath, delivery)
    delivery = validate_core_delivery(repo, base, sha) if repo.name == "samantha-core" else None
    context = {
        "github.sha": sha, "github.event.pull_request.head.sha": sha,
        "github.event.pull_request.base.sha": base, "github.event.before": base,
        "github.event_name": "pull_request" if pr != "-" else "push",
    }
    passed = 0
    with logpath.open("w", encoding="utf-8", buffering=1) as log:
        def note(text):
            print(text, file=log, flush=True)
            print(text, flush=True)
        note(f"LOCALCI_START repo={repo.name} sha={sha} pr={pr} base={base} jobs={len(jobs)}"
             + (" profile=s24" if s24 else ""))
        if delivery:
            note("DELIVERY_CONTRACT " + json.dumps(delivery, sort_keys=True))
        for job_name, job in jobs.items():
            if not isinstance(job, dict) or not isinstance(job.get("steps"), list):
                raise LocalCIError(f"Invalid job definition: {job_name}")
            if not conditional(job.get("if"), pr):
                raise LocalCIError(f"Cannot attest a skipped job: {job_name}")
            space = Path(tempfile.mkdtemp(prefix="localci-" + repo.name + "-" + job_name + "-",
                                          dir=os.getenv("LOCALCI_TMP_ROOT") or None)).resolve()
            attached = False
            step_home = None
            try:
                command(["git", "worktree", "add", "--detach", str(space), sha], repo)
                attached = True
                env = dict(os.environ)
                env.update({"CI": "true", "GITHUB_ACTIONS": "true", "GITHUB_SHA": sha,
                            "GITHUB_WORKSPACE": str(space), "GITHUB_REPOSITORY": identity(repo),
                            "GITHUB_EVENT_NAME": context["github.event_name"],
                            "GITHUB_BASE_REF": base})
                runner = space / ".localci"
                runner.mkdir()
                if s24:
                    # Steps never see the live HOME (~/.openclaw, keys) nor runtime credentials.
                    env = {k: v for k, v in env.items() if not S24_STEP_ENV_DROP.match(k)}
                    # In Debian's own /tmp: a HOME under the Termux tree would make a nested localci
                    # (its own tests) take the step for raw Termux.
                    step_home = Path(tempfile.mkdtemp(prefix="localci-home-"))
                    env["HOME"] = str(step_home)
                    step_bin = os.getenv("LOCALCI_S24_STEP_BIN")  # the mirror-backed `gh` of the wrapper
                    if step_bin:
                        env["PATH"] = step_bin + os.pathsep + env.get("PATH", "")
                # GitHub Actions supplies the PR event file; local replay must
                # reproduce that contract for mandatory PR-template checks.
                event = {"pull_request": {
                    "number": int(pr), "body": refs.get("body") or "",
                    "base": {"sha": base}, "head": {"sha": sha}
                }} if pr != "-" else {}
                event_path = runner / "github-event.json"
                event_path.write_text(json.dumps(event), encoding="utf-8")
                env["GITHUB_EVENT_PATH"] = str(event_path)
                env["GITHUB_ENV"] = str(runner / "env")
                env["GITHUB_OUTPUT"] = str(runner / "output")
                env["RUNNER_TEMP"] = str(runner)
                for mapping in (workflow.get("env") or {}, job.get("env") or {}):
                    if not isinstance(mapping, dict):
                        raise LocalCIError("Invalid workflow env")
                    env.update({str(k): expressions(v, context) for k, v in mapping.items()})
                defaults = (job.get("defaults") or {}).get("run") or {}
                note(f"JOB_START {job_name} sha={sha}")
                for idx, step in enumerate(job["steps"], 1):
                    if not conditional(step.get("if"), pr):
                        note(f"STEP_CONDITIONAL_SKIP {job_name}:{idx}")
                        continue
                    title = step.get("name") or step.get("uses") or str(idx)
                    note(f"STEP_START {job_name}:{idx} {title}")
                    tick = time.monotonic()
                    if step.get("uses"):
                        action = str(step["uses"]).split("@")[0]
                        if action in ("actions/setup-node", "actions/setup-python"):
                            py = action.endswith("python")
                            ver = str((step.get("with") or {}).get("python-version" if py else "node-version", ""))
                            if py and ver != "3.12":
                                raise LocalCIError("Only workflow Python 3.12 supported")
                            env["PATH"] = bin_for("python" if py else "node",
                                ver if py else int(ver.split(".")[0])) + os.pathsep + env["PATH"]
                        elif action != "actions/checkout":
                            raise LocalCIError(f"Unsupported uses step: {action}")
                        result = 0
                    elif "run" in step:
                        relative = step.get("working-directory") or defaults.get("working-directory") or "."
                        cwd = (space / relative).resolve()
                        if (cwd != space and space not in cwd.parents) or not cwd.is_dir():
                            raise LocalCIError(f"Unsafe or absent working directory: {relative}")
                        local_env = dict(env)
                        local_env.update({str(k): expressions(v, context)
                                          for k, v in (step.get("env") or {}).items()})
                        script = expressions(step["run"], context)
                        proc = subprocess.Popen(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
                            cwd=cwd, env=local_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, errors="replace")
                        for line in proc.stdout:
                            log.write(line)
                        result = proc.wait()
                        apply_github_env(Path(env["GITHUB_ENV"]), env)
                    else:
                        raise LocalCIError(f"Unsupported blank step: {job_name}:{idx}")
                    note(f"STEP_END {job_name}:{idx} exit={result} seconds={time.monotonic()-tick:.1f}")
                    if result:
                        note(f"LOCALCI_RESULT exit={result} sha={sha} job={job_name} step={idx}")
                        return result
                    passed += 1
                note(f"JOB_OK {job_name}")
            finally:
                if attached:
                    subprocess.run(["git", "worktree", "remove", "--force", str(space)], cwd=repo,
                                   capture_output=True)
                shutil.rmtree(space, ignore_errors=True)
                if step_home:
                    shutil.rmtree(step_home, ignore_errors=True)
        note(f"LOCALCI_RESULT exit=0 sha={sha} jobs={len(jobs)} steps={passed}")
    return 0



# In-memory evidence only. No JSON/log/sidecar constructor or durable verifier.
_CI_PROOF_SEAL = object()


class CanonicalCIProof:
    """Opaque capability issued only after this owner's actual run completes.

    The host process/module is trusted. This is not a signature or protection
    against hostile Python in that process, nor a durable cross-process grant.
    """
    __slots__ = ("__facts", "__seal")

    def __init__(self, facts, *, _seal=None):
        if _seal is not _CI_PROOF_SEAL:
            raise LocalCIError("canonical_ci_private_producer_required")
        self.__facts = facts
        self.__seal = _seal

    def __reduce__(self):
        raise TypeError("canonical_ci_proof_is_not_serializable")

    def _facts(self, seal):
        if seal is not _CI_PROOF_SEAL or self.__seal is not seal:
            raise LocalCIError("canonical_ci_private_producer_required")
        return self.__facts


def _proof_pr(repo, sha, pr):
    if not SHA.fullmatch(sha) or not isinstance(pr, str) or not pr.isdecimal() or int(pr) <= 0:
        raise LocalCIError("canonical_ci_sha40_and_pr_required")
    repository = identity(repo)
    raw = json.loads(command(["gh", "api", f"repos/{repository}/pulls/{pr}"], repo))
    head = (raw.get("head") or {}).get("sha")
    base = (raw.get("base") or {}).get("sha")
    if head != sha or not SHA.fullmatch(base or "") or raw.get("number") != int(pr):
        raise LocalCIError("canonical_ci_pr_identity_changed")
    return {"repository": repository, "head": head, "base": base, "pr_number": int(pr)}


def _committed_json_subject(repo, sha, path):
    if (not isinstance(path, str) or not path or path.startswith(('/', '-'))
            or any(part in {'', '.', '..', '.git'} for part in path.split('/'))):
        raise LocalCIError("canonical_ci_subject_path_invalid")
    mode = command(["git", "ls-tree", sha, "--", path], repo).split()
    if not mode or mode[0] not in {'100644', '100755'}:
        raise LocalCIError("canonical_ci_committed_regular_subject_required")
    size = int(command(["git", "cat-file", "-s", f"{sha}:{path}"], repo))
    if size > 2 * 1024 * 1024:
        raise LocalCIError("canonical_ci_subject_budget_exceeded")
    raw = subprocess.run(["git", "cat-file", "blob", f"{sha}:{path}"], cwd=repo,
                         capture_output=True, check=True, timeout=10).stdout
    value = json.loads(raw)
    canonical = json.dumps(value, ensure_ascii=True, sort_keys=True,
                           separators=(",", ":"), allow_nan=False).encode()
    return {"path": path, "blob_sha256": hashlib.sha256(raw).hexdigest(),
            "subject_digest": hashlib.sha256(canonical).hexdigest()}


def _proof_file_digest(path):
    value = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise LocalCIError('canonical_ci_regular_output_required')
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def _canonical_pid_command():
    executable = shutil.which('bwrap')
    if not executable:
        return None
    # Lifetime confinement only: retain the existing CI mounts/env/network.
    # A private PID init tears down ALL descendants, even detached sessions.
    return [executable, '--unshare-user', '--unshare-pid', '--die-with-parent',
            '--new-session', '--bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--']


SUBREAPER_FLAG = "--localci-subreaper"


def _canonical_subreaper_command():
    # Where user namespaces are refused (Android: the S24), the same lifetime contract from a child
    # subreaper: every orphaned descendant, detached sessions included, is reparented to it and
    # killed before it exits. Linux only; the probe in _run_canonical_ci_process proves it works.
    if not sys.platform.startswith("linux"):
        return None
    return [sys.executable, str(Path(__file__).resolve()), SUBREAPER_FLAG, "--"]


def _direct_children(pid):
    children = []
    for entry in os.scandir("/proc"):
        if not entry.name.isdecimal():
            continue
        try:
            stat_line = Path(entry.path, "stat").read_text()
        except OSError:
            continue
        fields = stat_line[stat_line.rindex(")") + 2:].split()
        if int(fields[1]) == pid:
            children.append(int(entry.name))
    return children


def _kill_all_descendants(deadline_seconds=20):
    """SIGKILL every child until none is left; orphans of killed children land here next round."""
    me, deadline = os.getpid(), time.monotonic() + deadline_seconds
    while time.monotonic() < deadline:
        children = _direct_children(me)
        for pid in children:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            return True
        if not children:
            time.sleep(0.01)
    return False


def _subreaper_main(argv):
    """Run argv as a child, then tear down everything it left behind; a failed teardown is a failure."""
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        return 125
    parent = os.getppid()
    libc.prctl(1, signal.SIGTERM, 0, 0, 0)  # PR_SET_PDEATHSIG: losing the owner tears down too
    if os.getppid() != parent:
        return 125

    class _Stop(Exception):
        pass

    def stop(*_):
        raise _Stop

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    code = 143
    try:
        code = subprocess.Popen(argv, start_new_session=True).wait()
    except _Stop:
        pass
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if not _kill_all_descendants():
            code = 126
    return code


def _run_canonical_ci_process(repo, sha, pr, log):
    """(exit code, process lifetime) of exactly one contained owner run; None if no containment works."""
    for command_line, lifetime in ((_canonical_pid_command(), "PID_namespace_teardown"),
                                   (_canonical_subreaper_command(), "subreaper_teardown")):
        if command_line is None:
            continue
        try:
            probe = subprocess.run(command_line + [sys.executable, '-c', 'pass'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        except (OSError, subprocess.SubprocessError):
            continue
        if probe.returncode == 0:
            break
    else:
        return None
    # Exactly the same CLI owner, once; never fall back to an uncontained run.
    process = subprocess.Popen(command_line + [sys.executable, str(Path(__file__).resolve()),
        str(repo), sha, pr, str(log)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)
    try:
        return process.wait(), lifetime
    except BaseException:
        if lifetime == "subreaper_teardown":
            # The subreaper must outlive its descendants to kill them: ask first, force after.
            try: os.kill(process.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: process.wait(timeout=25)
            except subprocess.TimeoutExpired: pass
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        process.wait(timeout=5)
        raise


def run_ci_evidence(repo_arg, sha, pr, output, *, subject_path, expected_subject_digest):
    """Explicit one-shot API of the same canonical runner, not a second CI.

    A subject must be a committed regular JSON artifact at the tested SHA. This
    binds source/CI identity, not execution or semantic truth of that artifact.
    No workflow markers are parsed to establish success. Real run_ci return
    and PR metadata before/after are mandatory. Caller invokes this explicitly.
    """
    repo = Path(repo_arg).resolve()
    before = _proof_pr(repo, sha, pr)
    if repo.name not in WORKFLOWS:
        raise LocalCIError("canonical_ci_repository_unsupported")
    workflow_path = WORKFLOWS[repo.name]
    workflow = subprocess.run(["git", "cat-file", "blob", f"{sha}:{workflow_path}"], cwd=repo,
                              capture_output=True, check=True, timeout=10).stdout
    subject = _committed_json_subject(repo, sha, subject_path)
    if subject['subject_digest'] != expected_subject_digest:
        raise LocalCIError('canonical_ci_subject_binding_changed')
    runner_path = Path(__file__).resolve()
    runner_digest = hashlib.sha256(_proof_regular_bytes(runner_path)).hexdigest()
    if runner_digest != _LOADED_RUNNER_SHA256:
        raise LocalCIError('canonical_ci_loaded_owner_changed')
    runner_repo = runner_path.parents[1]
    runner_revision = command(["git", "rev-parse", "HEAD"], runner_repo)
    committed_runner = subprocess.run(["git", "cat-file", "blob", runner_revision + ":tools/localci.py"],
        cwd=runner_repo, capture_output=True, check=True, timeout=10).stdout
    if not SHA.fullmatch(runner_revision) or hashlib.sha256(committed_runner).hexdigest() != runner_digest:
        raise LocalCIError("canonical_ci_committed_owner_required")
    log = Path(output).resolve()
    if log.exists() or log.is_symlink():
        raise LocalCIError("canonical_ci_fresh_output_required")
    contained = _run_canonical_ci_process(repo, sha, pr, log)
    if contained is None:
        return None  # No private proof: no containment available, no bare fallback.
    result, lifetime = contained
    if type(result) is not int or result != 0:
        raise LocalCIError("canonical_ci_terminal_failure")
    after = _proof_pr(repo, sha, pr)
    if before != after or runner_digest != hashlib.sha256(_proof_regular_bytes(__file__)).hexdigest():
        raise LocalCIError("canonical_ci_source_or_pr_changed")
    if not log.is_file() or log.is_symlink():
        raise LocalCIError("canonical_ci_durable_output_required")
    facts = dict(before, kind="canonical_localci", executed=True, exit_code=result,
                 runner_digest=runner_digest, runner_revision=runner_revision, workflow_path=workflow_path,
                 workflow_digest=hashlib.sha256(workflow).hexdigest(),
                 subject=subject, log_path=str(log), log_digest=_proof_file_digest(log),
                 repo_path=str(repo), proof_scope="canonical_CI_and_committed_artifact_identity_only", process_lifetime=lifetime)
    return CanonicalCIProof(facts, _seal=_CI_PROOF_SEAL)


def verify_ci_evidence(proof, *, repository, head, pr_number, subject_digest):
    """Recheck the private producer instance; never imports PASS from a file.

    Missing instance after restart is closed. Rechecking the proof never reruns
    CI, never polls, and never grants G4/G5 or artifact semantic qualification.
    """
    if type(proof) is not CanonicalCIProof:
        return {"status": "NOT_IMPLEMENTED", "reason": "canonical_ci_private_proof_unavailable"}
    facts = proof._facts(_CI_PROOF_SEAL)
    if (facts['repository'], facts['head'], facts['pr_number'], facts['subject']['subject_digest']) != (repository, head, pr_number, subject_digest):
        raise LocalCIError("canonical_ci_subject_binding_changed")
    current = _proof_pr(Path(facts['repo_path']), head, str(pr_number))
    if current != {key: facts[key] for key in ('repository', 'head', 'base', 'pr_number')}:
        raise LocalCIError("canonical_ci_pr_identity_changed")
    log = Path(facts['log_path'])
    if (not log.is_file() or log.is_symlink() or _proof_file_digest(log) != facts['log_digest']
            or hashlib.sha256(_proof_regular_bytes(__file__)).hexdigest() != facts['runner_digest']):
        raise LocalCIError("canonical_ci_artifact_or_owner_changed")
    encoded = json.dumps(facts, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode()
    return {"status": "PASS", "kind": "canonical_localci", "executed": True,
            "head": head, "subject_digest": subject_digest, "pr_number": pr_number, "exit_code": 0,
            "evidence_digest": hashlib.sha256(encoded).hexdigest(),
            "base": facts['base'], "runner_digest": facts['runner_digest'], "runner_revision": facts['runner_revision'],
            "workflow_digest": facts['workflow_digest'], "log_digest": facts['log_digest'],
            "artifact_digest": facts['subject']['blob_sha256'], "proof_scope": facts['proof_scope']}


def main():
    if sys.argv[1:2] == [SUBREAPER_FLAG] and sys.argv[2:3] == ["--"] and len(sys.argv) > 3:
        return _subreaper_main(sys.argv[3:])
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("repository", "sha", "pr", "output"):
        parser.add_argument(arg)
    args = parser.parse_args()
    try:
        return run_ci(args.repository, args.sha, args.pr, args.output)
    except Exception as exc:
        message = f"LOCALCI_RESULT exit=1 error={str(exc)[:450]}"
        print(message, file=sys.stderr)
        try:
            path = Path(args.output).expanduser().resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as output:
                output.write(message + "\n")
        except OSError:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
