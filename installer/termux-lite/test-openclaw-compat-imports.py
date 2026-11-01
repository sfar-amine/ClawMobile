#!/usr/bin/env python3
"""Every module a compatibility replacement imports exists in the same OpenClaw build and exports the names it binds.

S24 rehearsal of OpenClaw 2026.10.9 (01/11/2026): the 2026.10.9 variant of `agent-exec-auth-scope` kept the
2026.9.6 line `import { c as getScopedAuthProfileEnv } from "./store-CGYBYVbs.mjs"`; that chunk does not exist in
the 2026.10.9 npm build (the function is `s` of `store-C7nkCeF3.mjs`, `c` is another export), so the gateway refused
to start with ERR_MODULE_NOT_FOUND. Anchors and hashes were all right; only the imported module was wrong.

For every set (`openclaw-compat/*.json`) and every variant (`files` = `package_version`, then each `packages` key),
each `import … from "./X"` / `export … from "./X"` that a replacement introduces must
resolve, from the patched module's own directory, to a public module of the same version, and each bound name
(`{ a as b }` binds export `a`, `{ name }` binds `name`, a default import binds `default`) must be exported by that
module after the same variant has patched it. Pinned `predecessors` are only ever reversed (an older patched state
is restored to its verified original, never applied), so their imports are history, not live code. The modules come from the captured fixtures of that version; with
`OPENCLAW_COMPAT_ARCHIVE_DIR` holding `openclaw-<version>.tgz` (npm pack), OpenClaw-rooted targets are also resolved
at their exact path inside the published archive."""
import gzip
import json
import os
from pathlib import Path
import posixpath
import re
import tarfile
import unittest

HERE = Path(__file__).parent
COMPAT = HERE / "openclaw-compat"
FIXTURES = HERE.parent.parent / "openclaw-plugin-mobile-ui/fixtures"
# Public modules of each pinned build, looked up by file name (the fixtures are flat), first match wins.
SOURCES = {
    "2026.9.6": ("openclaw-2026.9.6-compat", "s24-2026-10-25-model-flow-sdk", "s24-2026-10-23-native-auth-scope"),
    "2026.10.9": ("openclaw-2026.10.9-compat",),
}

STATEMENT = re.compile(
    r"\b(?P<kind>import|export)\s*(?P<clause>[^;\"'`]*?)\s*from\s*[\"'](?P<spec>\.{1,2}/[^\"']+)[\"']"
    r"|\bimport\s*[\"'](?P<bare>\.{1,2}/[^\"']+)[\"']")
DYNAMIC = re.compile(r"\bimport\s*\(\s*[\"'](\.{1,2}/[^\"']+)[\"']\s*\)")
IDENT = r"[A-Za-z_$][\w$]*"


def statements(text):
    """(kind, clause, specifier) of every static relative import/re-export, plus dynamic relative imports."""
    found = []
    for match in STATEMENT.finditer(text):
        if match.group("bare"):
            found.append(("import", "", match.group("bare")))
        else:
            found.append((match.group("kind"), " ".join(match.group("clause").split()), match.group("spec")))
    found.extend(("dynamic", "", spec) for spec in DYNAMIC.findall(text))
    return found


def introduced(before, after):
    """Statements present in `after` more often than in `before`: what the replacement adds or rewrites."""
    remaining = statements(before)
    added = []
    for item in statements(after):
        if item in remaining:
            remaining.remove(item)
        else:
            added.append(item)
    return added


def bound_names(kind, clause):
    """Export names a statement requires from its target; None for a namespace (`* as ns`) or side-effect form."""
    names = []
    braces = re.search(r"\{([^}]*)\}", clause)
    if braces:
        for part in braces.group(1).split(","):
            part = part.strip()
            if not part:
                continue
            if part.startswith("type "):
                continue
            names.append(re.split(r"\s+as\s+", part)[0].strip())
    head = clause[:braces.start()] if braces else clause
    if kind == "import":
        default = re.match(r"\s*(" + IDENT + r")\s*(?:,|$)", head)
        if default and default.group(1) != "type":
            names.append("default")
    return names


def exported_names(text):
    """Export names of an ES module as published (rolldown output: `export { local as a, … };` plus declarations)."""
    names, star = set(), []
    for match in re.finditer(r"\bexport\s*\{([^}]*)\}\s*(?:from\s*[\"']([^\"']+)[\"'])?", text):
        for part in match.group(1).split(","):
            part = part.strip()
            if part and not part.startswith("type "):
                names.add(re.split(r"\s+as\s+", part)[-1].strip())
    names.update(re.findall(r"\bexport\s+(?:async\s+)?function\s*\*?\s*(" + IDENT + ")", text))
    names.update(re.findall(r"\bexport\s+(?:const|let|var|class)\s+(" + IDENT + ")", text))
    if re.search(r"\bexport\s+default\b", text):
        names.add("default")
    star.extend(re.findall(r"\bexport\s*\*\s*from\s*[\"']([^\"']+)[\"']", text))
    return names, star


def variants(manifest):
    yield manifest["package_version"], manifest.get("files") or []
    for version, chosen in (manifest.get("packages") or {}).items():
        yield version, chosen["files"]


class Source:
    """Public modules of one version: captured fixtures, optionally the published npm archive."""

    def __init__(self, version, archive_dir=None):
        self.version = version
        self.dirs = [FIXTURES / name for name in SOURCES.get(version, ())]
        self.archive = None
        if archive_dir:
            candidate = Path(archive_dir) / f"openclaw-{version}.tgz"
            if candidate.is_file():
                self.archive = tarfile.open(candidate)
                self.members = {member.name: member for member in self.archive if member.isfile()}

    def read(self, root, path):
        """(bytes, where) of the module at `path` under `root`, or (None, reason)."""
        if self.archive is not None and root == "openclaw":
            member = self.members.get("package/" + path)
            if member is None:
                return None, f"absent from openclaw-{self.version}.tgz at package/{path}"
            return self.archive.extractfile(member).read(), f"openclaw-{self.version}.tgz"
        name = posixpath.basename(path)
        for folder in self.dirs:
            for candidate, unpack in ((folder / name, False), (folder / (name + ".gz"), True)):
                if candidate.is_file():
                    data = candidate.read_bytes()
                    return (gzip.decompress(data) if unpack else data), str(candidate.relative_to(FIXTURES))
        return None, f"absent from the {self.version} fixtures ({', '.join(SOURCES.get(self.version, ())) or 'none'})"


def patched_text(source, entries, root, path, cache):
    """Target module text after the same variant has patched it (exports the variant adds count)."""
    key = (root, path)
    if key not in cache:
        data, where = source.read(root, path)
        if data is None:
            cache[key] = (None, where)
        else:
            text = data.decode()
            for entry in entries:
                if entry["root"] == root and entry["path"] == path:
                    for before, after in entry["replacements"]:
                        if text.count(before) == 1:
                            text = text.replace(before, after)
            cache[key] = (text, where)
    return cache[key]


def check_variant(name, version, entries, archive_dir=None):
    """Problems (strings) of one variant, as its replacements would leave the patched modules."""
    source = Source(version, archive_dir)
    cache, problems = {}, []
    for entry in entries:
        for before, after in entry["replacements"]:
            for kind, clause, spec in introduced(before, after):
                target = posixpath.normpath(posixpath.join(posixpath.dirname(entry["path"]), spec))
                where = f"{name} {version} {entry['path']}: {kind} {clause + ' ' if clause else ''}from \"{spec}\""
                text, origin = patched_text(source, entries, entry["root"], target, cache)
                if text is None:
                    problems.append(f"{where}: module {target} {origin}")
                    continue
                required = bound_names(kind if kind != "dynamic" else "import", clause)
                exports, stars = exported_names(text)
                for star in stars:
                    star_target = posixpath.normpath(posixpath.join(posixpath.dirname(target), star))
                    star_text, _ = patched_text(source, entries, entry["root"], star_target, cache)
                    if star_text is not None:
                        exports |= exported_names(star_text)[0] - {"default"}
                for wanted in required:
                    if wanted not in exports:
                        problems.append(f"{where}: {target} ({origin}) exports no `{wanted}`"
                                        f" (exports: {', '.join(sorted(exports)) or 'none'})")
    if source.archive is not None:
        source.archive.close()
    return problems


def check_all(archive_dir=None):
    problems = []
    for path in sorted(COMPAT.glob("*.json")):
        manifest = json.loads(path.read_text())
        for version, entries in variants(manifest):
            problems += check_variant(path.stem, version, entries, archive_dir)
    return problems


class ImportTargets(unittest.TestCase):
    def test_every_set_and_variant_imports_real_modules_and_exports(self):
        problems = check_all(os.environ.get("OPENCLAW_COMPAT_ARCHIVE_DIR"))
        self.assertEqual(problems, [], "\n".join(problems))

    def test_every_variant_version_has_captured_sources(self):
        for path in sorted(COMPAT.glob("*.json")):
            for version, entries in variants(json.loads(path.read_text())):
                if entries:
                    self.assertIn(version, SOURCES, path.stem)

    def test_rehearsal_regression_missing_chunk_and_wrong_letter_are_caught(self):
        """The 2026.10.9 agent-exec-auth-scope variant as it failed on the S24 on 01/11 is refused, twice over."""
        manifest = json.loads((COMPAT / "agent-exec-auth-scope.json").read_text())
        entry = manifest["packages"]["2026.10.9"]["files"][0]
        broken = {**entry, "replacements": entry["predecessors"][0]["replacements"]}
        problems = check_variant("agent-exec-auth-scope", "2026.10.9", [broken])
        self.assertEqual(len(problems), 1, problems)
        self.assertIn('from "./store-CGYBYVbs.mjs": module dist/store-CGYBYVbs.mjs absent', problems[0])
        # Right chunk, letter kept from 2026.9.6: `c` is getScopedSharedAuthStore there, `s` is the wanted function.
        letter = [[before, after.replace("./store-CGYBYVbs.mjs", "./store-C7nkCeF3.mjs")] for before, after in broken["replacements"]]
        text, _ = patched_text(Source("2026.10.9"), [], "openclaw", "dist/store-C7nkCeF3.mjs", {})
        self.assertIn("getScopedSharedAuthStore as c", text)
        self.assertIn("getScopedAuthProfileEnv as s", text)
        wrong = [[before, after.replace("{ c as getScopedAuthProfileEnv }", "{ q as getScopedAuthProfileEnv }")] for before, after in letter]
        problems = check_variant("agent-exec-auth-scope", "2026.10.9", [{**broken, "replacements": wrong}])
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("exports no `q`", problems[0])
        # The broken variant survives only as a predecessor, to upgrade a candidate patched with it: the variant is clean.
        self.assertEqual(check_variant("agent-exec-auth-scope", "2026.10.9", [entry]), [])

    def test_parser_reads_published_forms(self):
        self.assertEqual(introduced('import "node:util";', 'import { s as f } from "./a.mjs";\nimport "node:util";'),
                         [("import", "{ s as f }", "./a.mjs")])
        self.assertEqual(introduced('import { a as x } from "./a.mjs";', 'import { a as x, b as y } from "./a.mjs";'),
                         [("import", "{ a as x, b as y }", "./a.mjs")])
        self.assertEqual(introduced('x', 'x\nexport { t as run } from "../b.js";\nconst m = await import("./c.mjs");'),
                         [("export", "{ t as run }", "../b.js"), ("dynamic", "", "./c.mjs")])
        self.assertEqual(bound_names("import", "{ a as resolveHookModelSelection, applyHookModelProfile }"),
                         ["a", "applyHookModelProfile"])
        self.assertEqual(bound_names("import", "main, { t as helper }"), ["t", "default"])
        self.assertEqual(bound_names("import", "* as ns"), [])
        names, _ = exported_names("export { first as a, second as b };\nexport function third() {}\nexport const fourth = 1;")
        self.assertEqual(names, {"a", "b", "third", "fourth"})


if __name__ == "__main__":
    unittest.main()
