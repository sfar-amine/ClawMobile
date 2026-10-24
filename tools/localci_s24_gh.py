#!/usr/bin/env python3
"""`gh` for CI steps on the S24 profile: the two read-only API forms the workflows use, from local mirrors.

The S24 has git access but no gh token. tools/localci-s24.sh fetches every Samantha repository into
/ci/repos/<name> just before the run; this answers, from those mirrors only:
  gh api repos/<owner>/<repo>/git/ref/heads/<branch> [--jq .object.sha]
  gh api repos/<owner>/<repo>/contents/<path>?ref=<sha> [--jq .content]
Anything else exits 2 with a message: a step never silently succeeds on an unsupported call.
"""
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys

MIRRORS = Path(os.environ.get("LOCALCI_S24_MIRRORS", "/ci/repos"))
REPO = re.compile(r"^repos/[A-Za-z0-9_.-]+/(samantha-core|samantha-ui-playbooks|samantha-context-private)/(.+)$")


def fail(message):
    print(f"localci-s24 gh: {message}", file=sys.stderr)
    raise SystemExit(2)


def git(repo, *args):
    run = subprocess.run(["git", "-C", str(repo), *args], capture_output=True)
    if run.returncode:
        fail(f"git {' '.join(args[:2])} failed in {repo.name}: {run.stderr.decode(errors='replace')[:200]}")
    return run.stdout


def main(argv):
    if len(argv) < 2 or argv[0] != "api":
        fail("only `gh api` is available on the S24 CI profile")
    endpoint, rest = argv[1], argv[2:]
    jq = None
    if rest:
        if len(rest) != 2 or rest[0] != "--jq":
            fail(f"unsupported arguments: {rest}")
        jq = rest[1]
    match = REPO.match(endpoint)
    if not match:
        fail(f"unsupported endpoint: {endpoint}")
    repo = MIRRORS / match.group(1)
    if not (repo / ".git").exists():
        fail(f"mirror missing: {repo}")
    tail = match.group(2)
    if tail.startswith("git/ref/heads/"):
        branch = tail[len("git/ref/heads/"):]
        sha = git(repo, "rev-parse", "--verify", f"refs/remotes/origin/{branch}^{{commit}}").decode().strip()
        value = {"ref": f"refs/heads/{branch}", "object": {"sha": sha, "type": "commit"}}
        if jq not in (None, ".object.sha"):
            fail(f"unsupported --jq for a ref: {jq}")
        print(sha if jq else json.dumps(value))
        return 0
    contents = re.fullmatch(r"contents/([^?]+)\?ref=([0-9a-f]{40})", tail)
    if contents:
        path, ref = contents.groups()
        if any(part in {"", ".", ".."} for part in path.split("/")):
            fail(f"unsafe path: {path}")
        blob = git(repo, "cat-file", "blob", f"{ref}:{path}")
        encoded = base64.encodebytes(blob).decode()
        if jq not in (None, ".content"):
            fail(f"unsupported --jq for contents: {jq}")
        print(encoded if jq else json.dumps({"path": path, "encoding": "base64", "content": encoded}), end="")
        return 0
    fail(f"unsupported endpoint: {endpoint}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
