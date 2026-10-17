# Aide aux tests shell (sourcée) : exécuter les scripts Termux hors Termux.
# Les scripts de production gardent leur shebang Termux ; seuls les doubles et
# copies temporaires créés par un test sont adaptés à l'hôte. Voir host_test_support.py.
HOST_TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERMUX_BIN_DIR=/data/data/com.termux/files/usr/bin

# Bash à utiliser : celui de Termux s'il existe, sinon celui de l'hôte.
host_bash() {
  if [ -x "$TERMUX_BIN_DIR/bash" ]; then printf '%s\n' "$TERMUX_BIN_DIR/bash"; else command -v bash; fi
}

# Adapte les shebangs Termux des fichiers temporaires donnés (fichiers ou dossiers) ; rien sur Termux.
host_adapt_shebangs() {
  [ -x "$TERMUX_BIN_DIR/bash" ] && return 0
  python3 - "$HOST_TEST_SUPPORT_DIR" "$@" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from host_test_support import adapt_shebangs
for p in sys.argv[2:]:
    adapt_shebangs(p)
PY
}
