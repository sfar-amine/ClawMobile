#!/usr/bin/env python3
"""Single owner of local CI, used off-phone for all Samantha repositories.

Usage: python3 samantha-core/tools/localci.py <repo> <40-char-head-sha> <PR|-> <log>
Requires PyYAML, git, bash, gh (for PRs) and workflow-declared toolchains.
Overrides: LOCALCI_NODE20_BIN, LOCALCI_NODE22_BIN, LOCALCI_NODE26_BIN,
LOCALCI_PYTHON312_BIN; each specifies a toolchain bin directory.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import yaml

WORKFLOWS = {
    "samantha-core": ".github/workflows/ci.yml",
    "samantha-ui-playbooks": ".github/workflows/documentation.yml",
    "samantha-context-private": ".github/workflows/context-contract.yml",
}
SHA = re.compile(r"^[0-9a-f]{40}$")
EXPR = re.compile(r"\$\{\{\s*(.*?)\s*\}\}")


class LocalCIError(Exception):
    pass


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
    binary = "node" if kind == "node" else "python3"
    paths = [Path(configured).expanduser()] if configured else ([fallback] if fallback else [])
    paths.append(Path(shutil.which(binary) or "/not-found").parent)
    for path in paths:
        folder = path if path.is_dir() else path.parent
        executable = folder / binary
        if not executable.is_file():
            continue
        probe = subprocess.run(
            [str(executable), "-p", "process.versions.node.split('.')[0]"] if kind == "node"
            else [str(executable), "-c", "import sys; print('%s.%s'%sys.version_info[:2])"],
            capture_output=True, text=True)
        if probe.returncode == 0 and probe.stdout.strip() == str(version):
            return str(folder)
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


def run_ci(repo_arg, sha, pr, output):
    if not SHA.fullmatch(sha):
        raise LocalCIError("Full exact 40-character head SHA required")
    if "/com.termux/" in str(Path.home()) or os.getenv("PREFIX", "").startswith("/data/data/com.termux"):
        raise LocalCIError("Do not run CI on the production S24")
    repo = Path(repo_arg).expanduser().resolve()
    if repo.name not in WORKFLOWS or not (repo / ".git").exists():
        raise LocalCIError("Expected one of three local Samantha repository checkouts")
    if command(["git", "cat-file", "-t", sha], repo) != "commit":
        raise LocalCIError("Fetch exact GitHub SHA before running")
    if pr != "-":
        if not pr.isdecimal() or not shutil.which("gh"):
            raise LocalCIError("gh CLI and numeric PR required to verify exact head")
        refs = json.loads(command(
            ["gh", "pr", "view", pr, "-R", identity(repo), "--json", "headRefOid,baseRefOid"], repo))
        if refs.get("headRefOid") != sha or not SHA.fullmatch(refs.get("baseRefOid") or ""):
            raise LocalCIError("GitHub PR head SHA mismatch")
        base = refs["baseRefOid"]
    else:
        base = command(["git", "rev-parse", sha + "^"], repo)
    path = WORKFLOWS[repo.name]
    workflow = yaml.safe_load(command(["git", "show", f"{sha}:{path}"], repo))
    jobs = workflow.get("jobs") if isinstance(workflow, dict) else None
    if not isinstance(jobs, dict) or not jobs:
        raise LocalCIError("Missing workflow jobs")
    context = {
        "github.sha": sha, "github.event.pull_request.head.sha": sha,
        "github.event.pull_request.base.sha": base, "github.event.before": base,
        "github.event_name": "pull_request" if pr != "-" else "push",
    }
    logpath = Path(output).expanduser().resolve()
    logpath.parent.mkdir(parents=True, exist_ok=True)
    passed = 0
    with logpath.open("w", encoding="utf-8", buffering=1) as log:
        def note(text):
            print(text, file=log, flush=True)
            print(text, flush=True)
        note(f"LOCALCI_START repo={repo.name} sha={sha} pr={pr} base={base} jobs={len(jobs)}")
        for job_name, job in jobs.items():
            if not isinstance(job, dict) or not isinstance(job.get("steps"), list):
                raise LocalCIError(f"Invalid job definition: {job_name}")
            if not conditional(job.get("if"), pr):
                raise LocalCIError(f"Cannot attest a skipped job: {job_name}")
            space = Path(tempfile.mkdtemp(prefix="localci-" + repo.name + "-" + job_name + "-",
                                          dir=os.getenv("LOCALCI_TMP_ROOT") or None)).resolve()
            attached = False
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
        note(f"LOCALCI_RESULT exit=0 sha={sha} jobs={len(jobs)} steps={passed}")
    return 0


def main():
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
