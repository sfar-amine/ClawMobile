"""Aide aux tests : exécuter les scripts Termux hors Termux (CI Ubuntu, conteneurs).

Les scripts de production gardent leur shebang Termux
(`#!/data/data/com.termux/files/usr/bin/bash` ou `python3`). Hors Termux, ce
chemin n'existe pas et l'exécution directe échoue en ENOENT. Les tests passent
donc par l'interpréteur (`host_cmd`) ou, quand un script de production en
appelle un autre directement, par une copie temporaire dont seuls les shebangs
Termux sont adaptés à l'hôte (`host_runtime_copy`). Les fichiers du dépôt ne
sont jamais modifiés. Ce module n'est utilisé que par les tests.
"""
import os
import pathlib
import shutil
import sys

TERMUX_BIN = "/data/data/com.termux/files/usr/bin/"


def on_termux():
    return os.path.exists(TERMUX_BIN + "bash")


def host_cmd(path):
    """Commande qui lance `path` via son interpréteur, sans dépendre du shebang."""
    p = str(path)
    if p.endswith(".sh"):
        return [shutil.which("bash") or "bash", p]
    if p.endswith(".py"):
        return [sys.executable, p]
    return [p]


def host_shebang(first_line):
    """Remplace un shebang Termux par l'interpréteur équivalent de l'hôte."""
    if not first_line.startswith("#!" + TERMUX_BIN):
        return first_line
    rest = first_line[len("#!" + TERMUX_BIN):].split()
    name, args = rest[0], rest[1:]
    if name.startswith("python"):
        target = sys.executable
    else:
        target = shutil.which(name) or "/usr/bin/env " + name
    return "#!" + " ".join([target, *args])


def adapt_shebangs(root):
    """Adapte en place les shebangs Termux des fichiers d'une copie temporaire (rien sur Termux)."""
    if on_termux():
        return
    root = pathlib.Path(root)
    for f in ([root] if root.is_file() else root.rglob("*")):
        if not f.is_file() or f.is_symlink():
            continue
        try:
            with f.open("rb") as h:
                head = h.read(2 + len(TERMUX_BIN))
        except OSError:
            continue
        if head != ("#!" + TERMUX_BIN).encode():
            continue
        data = f.read_bytes()
        first, sep, rest = data.partition(b"\n")
        mode = f.stat().st_mode
        f.write_bytes(host_shebang(first.decode()).encode() + sep + rest)
        f.chmod(mode)


def host_runtime_copy(src, dest):
    """Copie `src` vers `dest` (shebangs adaptés hors Termux) et rend le chemin à utiliser.

    Sur Termux, les scripts réels sont utilisés tels quels.
    """
    src = pathlib.Path(src)
    if on_termux():
        return src
    dest = pathlib.Path(dest)
    shutil.copytree(src, dest, ignore=shutil.ignore_patterns("__pycache__"), symlinks=True)
    adapt_shebangs(dest)
    return dest
