#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

R="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$R/install-openclaw.sh"
TERMUX_PREFIX="/data/data/com.termux/files/usr"
TERMUX_BASH="$TERMUX_PREFIX/bin/bash"
TMP_ROOT="$(mktemp -d "$HOME/.cache/tmp/clawmobile-login-shell-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

extract_function() {
  local name="$1"
  awk -v start="$name() {" '
    $0 == start {capture=1}
    capture {print}
    capture && $0 == "}" {exit}
  ' "$SOURCE"
}

eval "$(extract_function remove_bashrc_block)"
eval "$(extract_function write_login_shell_bootstrap)"
eval "$(extract_function write_shell_env)"

HOME="$TMP_ROOT/fresh"
PREFIX="$TERMUX_PREFIX"
PROJECT_DIR="$HOME/.openclaw-android"
BIN_DIR="$PROJECT_DIR/bin"
NODE_DIR="$PROJECT_DIR/node"
mkdir -p "$HOME" "$BIN_DIR" "$NODE_DIR/bin"

write_shell_env
write_login_shell_bootstrap

grep -Fqx "export PREFIX=\"$TERMUX_PREFIX\"" "$HOME/.bashrc"
grep -Fqx "export SHELL=\"$TERMUX_PREFIX/bin/bash\"" "$HOME/.bashrc"
grep -Fqx '# >>> ClawMobile Termux Login Bootstrap >>>' "$HOME/.bash_profile"
grep -Fqx '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"' "$HOME/.bash_profile"

actual="$(HOME="$HOME" "$TERMUX_BASH" -l -c 'printf "%s|%s|%s|%s|%s" "$SHELL" "$PREFIX" "$TMPDIR" "$TMP" "$TEMP"')"
expected="$TERMUX_PREFIX/bin/bash|$TERMUX_PREFIX|$TERMUX_PREFIX/tmp|$TERMUX_PREFIX/tmp|$TERMUX_PREFIX/tmp"
[ "$actual" = "$expected" ] || {
  printf 'login_env_mismatch expected=%s actual=%s\n' "$expected" "$actual" >&2
  exit 1
}

write_shell_env
write_login_shell_bootstrap
[ "$(grep -Fc '# >>> ClawMobile Termux OpenClaw Android >>>' "$HOME/.bashrc")" -eq 1 ]
[ "$(grep -Fc '# >>> ClawMobile Termux Login Bootstrap >>>' "$HOME/.bash_profile")" -eq 1 ]

HOME="$TMP_ROOT/existing"
PROJECT_DIR="$HOME/.openclaw-android"
BIN_DIR="$PROJECT_DIR/bin"
NODE_DIR="$PROJECT_DIR/node"
mkdir -p "$HOME" "$BIN_DIR" "$NODE_DIR/bin"
printf '%s\n' 'export KEEP_EXISTING_PROFILE=yes' > "$HOME/.profile"

write_shell_env
write_login_shell_bootstrap

[ ! -e "$HOME/.bash_profile" ]
grep -Fqx 'export KEEP_EXISTING_PROFILE=yes' "$HOME/.profile"
grep -Fqx '# >>> ClawMobile Termux Login Bootstrap >>>' "$HOME/.profile"
actual="$(HOME="$HOME" "$TERMUX_BASH" -l -c 'printf "%s|%s" "$KEEP_EXISTING_PROFILE" "$TMPDIR"')"
[ "$actual" = "yes|$TERMUX_PREFIX/tmp" ]

echo "openclaw login shell bootstrap: PASS"
