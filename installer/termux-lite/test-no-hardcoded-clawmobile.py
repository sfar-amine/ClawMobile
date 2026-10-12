#!/usr/bin/env python3
"""R10/R12 (fichier 52, point 1.4) : aucun chemin vers la copie de travail en dur.

Sur le S24, le runtime exécuté est la release Tier0 courante
(~/.openclaw/releases/current/termux-lite, donnée par `tier0-control.py root`),
et tier0-bootstrap.sh exporte CLAW_RUNTIME_ROOT. Un script qui appelle la copie
de travail en dur fait tourner un autre code que la release. Les scripts doivent
donc résoudre leur racine par CLAW_RUNTIME_ROOT, à défaut par leur propre
dossier ; les jobs planifiés générés pointent la release courante.

Seuls les fichiers de la liste blanche, chacun avec sa raison, peuvent nommer
la copie de travail : ils ont besoin du dépôt complet (plugin, git, docs), que
la release (termux-lite seul) ne contient pas.
"""
from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SELF = Path(__file__).resolve().name
REPO_DIR = "Claw" + "Mobile"  # découpé pour que ce test ne se détecte pas lui-même

# Formes d'un chemin vers la copie de travail : shell ($HOME, ${HOME}, ~, $HOME_DIR),
# Python (HOME / "...", Path.home() / '...') et tout chemin vers ses sous-dossiers.
PATTERN = re.compile(
    r"|".join(
        [
            REPO_DIR + r"/(?:installer|openclaw-plugin-mobile-ui|scripts)\b",
            r"(?:\$\{?HOME(?:_DIR)?\}?|~)/" + REPO_DIR + r"\b",
            r"(?:\bHOME|\bH|\bhome|Path\.home\(\))\s*/\s*[\"']" + REPO_DIR + r"\b",
        ]
    )
)

# Fichier (relatif à installer/termux-lite) -> raison de garder la copie de travail.
ALLOWLIST = {
    "bootstrap.sh": "installeur : clone ou met à jour le dépôt dans ~/" + REPO_DIR + " (CLAWMOBILE_HOME).",
    "lib.sh": "installeur : clawmobile_lite_repo_root localise le dépôt pour construire et installer le plugin, absent de la release.",
    "runtime-sync.sh": "depuis une release (health manager), retrouve le checkout déployé (plugin, outils de déploiement) ; CLAW_CORE_REPO prioritaire.",
    "project-room.py": "copie le dépôt samantha-core complet (docs, plugin, git) dans la salle projet, pas termux-lite ; CLAW_PROJECT_CORE prioritaire.",
    "test-slack-runtime-contract.py": "lit la source du plugin (absente de la release) en dernier recours et vérifie le contrat de lib.sh ci-dessus.",
}

# Jobs planifiés générés par l'installeur : leur chemin doit viser la release courante.
RELEASE_LINK = "$HOME/.openclaw/releases/current/termux-lite"


def text_files():
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts or "node_modules" in path.parts:
            continue
        try:
            yield path, path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue


def offenders():
    found = {}
    for path, text in text_files():
        rel = str(path.relative_to(ROOT))
        if rel == SELF:
            continue
        lines = [f"{i}: {line.strip()}" for i, line in enumerate(text.splitlines(), 1) if PATTERN.search(line)]
        if lines:
            found[rel] = lines
    return found


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NoHardcodedWorkingCopyTests(unittest.TestCase):
    def test_pattern_catches_known_forms(self):
        for sample in (
            'ROOT="${CLAW_RUNTIME_ROOT:-$HOME/' + REPO_DIR + '/installer/termux-lite}"',
            "CHILD=$HOME_DIR/" + REPO_DIR + "/installer/termux-lite/x.sh",
            "python3 ~/" + REPO_DIR + "/installer/termux-lite/x.py",
            "ROOT=H/'" + REPO_DIR + "/installer/termux-lite'",
            'fallback = HOME / "' + REPO_DIR + '/installer/termux-lite" / name',
            "str(HOME / '" + REPO_DIR + "')",
        ):
            self.assertRegex(sample, PATTERN)
        for sample in ("# >>> " + REPO_DIR + " Termux Login Bootstrap >>>", "Starting " + REPO_DIR + " Companion server"):
            self.assertNotRegex(sample, PATTERN)

    def test_no_hardcoded_working_copy_outside_allowlist(self):
        bad = {rel: lines for rel, lines in offenders().items() if rel not in ALLOWLIST}
        self.assertEqual(bad, {}, "chemin en dur vers la copie de travail : utiliser CLAW_RUNTIME_ROOT ou le dossier du script")

    def test_allowlist_is_justified_and_not_stale(self):
        found = offenders()
        for rel, reason in ALLOWLIST.items():
            self.assertTrue((ROOT / rel).is_file(), rel)
            self.assertGreater(len(reason), 20, rel)
            self.assertIn(rel, found, f"{rel} ne nomme plus la copie de travail : le retirer de la liste blanche")

    def test_runtime_root_fallbacks_use_script_dir(self):
        for path, text in text_files():
            if path.name == SELF:
                continue
            for match in re.finditer(r"CLAW_RUNTIME_ROOT:-([^}\n]*)", text):
                self.assertIn("dirname", match.group(1), f"{path.name}: {match.group(0)}")

    def test_generated_cron_points_current_release(self):
        setup = (ROOT / "claw-slack-purge-setup.sh").read_text()
        self.assertIn(f'RELEASE_ROOT="{RELEASE_LINK}"', setup)
        self.assertIn('\\"$JOB_ROOT/claw-slack-purge.mjs\\"', setup)
        self.assertNotIn('\\"$ROOT/claw-slack-purge.mjs\\"', setup)

    def test_python_fallbacks_resolve_next_to_script(self):
        with tempfile.TemporaryDirectory() as home:
            old = os.environ.get("HOME")
            os.environ["HOME"] = home
            try:
                gemini = load("gemini_request_r10", "gemini-request.py")
                fast = load("model_fast_path_r10", "model-fast-path.py")
            finally:
                if old is None:
                    os.environ.pop("HOME", None)
                else:
                    os.environ["HOME"] = old
            self.assertEqual(gemini.runtime_script("context-head.sh"), ROOT / "context-head.sh")
            self.assertEqual(fast._bridge_cli(Path(home)), ROOT / "claw-bridge-cli.py")

    def test_health_verdict_root_follows_runtime_root(self):
        code = "import importlib.util,sys;s=importlib.util.spec_from_file_location('hv',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.ROOT)"
        env = {k: v for k, v in os.environ.items() if k != "CLAW_RUNTIME_ROOT"}
        out = subprocess.run(["python3", "-c", code, str(ROOT / "health-verdict.py")], env=env, capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.strip(), str(ROOT))
        env["CLAW_RUNTIME_ROOT"] = "/release/termux-lite"
        out = subprocess.run(["python3", "-c", code, str(ROOT / "health-verdict.py")], env=env, capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.strip(), "/release/termux-lite")

    def test_shell_fallback_resolves_script_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            release = Path(tmp) / "releases/current/termux-lite"
            release.mkdir(parents=True)
            src = (ROOT / "openclaw-agent-secure").read_text()
            target = release / "openclaw-agent-secure"
            target.write_text(src)
            (release / "gateway-secretref-exec.sh").write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$0"\n')
            os.chmod(release / "gateway-secretref-exec.sh", 0o755)
            env = {k: v for k, v in os.environ.items() if k != "CLAW_RUNTIME_ROOT"}
            env["HOME"] = tmp
            out = subprocess.run(["bash", str(target), "--message", "x"], env=env, capture_output=True, text=True, check=True)
            self.assertEqual(out.stdout.strip(), str(release / "gateway-secretref-exec.sh"))


if __name__ == "__main__":
    unittest.main()
