#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
SRC="$ROOT/claw-live.py"
DST="$HOME/bin/claw-live"
LINK="$PREFIX/bin/claw-live"
BACKUPS="$HOME/.openclaw/backups/claw-live"
[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 2; }
python3 -m py_compile "$SRC"
mkdir -p "$HOME/bin" "$BACKUPS"
chmod 700 "$HOME/bin" "$BACKUPS"
if [ -e "$DST" ] && ! cmp -s "$SRC" "$DST"; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUPS/$stamp"
  cp -p "$DST" "$BACKUPS/$stamp/claw-live"
fi
tmp="$DST.tmp.$$"
cp "$SRC" "$tmp"
chmod 700 "$tmp"
mv -f "$tmp" "$DST"
ln -sfn "$DST" "$LINK"
command -v claw-live
