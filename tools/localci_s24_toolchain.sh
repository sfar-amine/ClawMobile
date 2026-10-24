#!/usr/bin/env bash
# Toolchains of the canonical local CI inside the S24 Debian (proot-distro), run as its root.
# Idempotent; every download is checked against the publisher's SHA-256 list before use.
# Installs: /opt/node20, /opt/node22, /opt/node26 (exact 26.11.1, as core ci.yml), /opt/python3.12,
# PyYAML for localci.py itself, git and file for the workflow steps. Prints one TOOLCHAIN line per tool.
set -euo pipefail
[ "$(uname -m)" = aarch64 ] || { echo "toolchain_arch_unsupported: $(uname -m)" >&2; exit 2; }
export DEBIAN_FRONTEND=noninteractive
need=()
for pkg in ca-certificates curl xz-utils python3-yaml python3-venv git file; do
  dpkg -s "$pkg" >/dev/null 2>&1 || need+=("$pkg")
done
if [ "${#need[@]}" -gt 0 ]; then
  apt-get update -qq && apt-get install -y -qq --no-install-recommends "${need[@]}" >/dev/null
fi

node_install() { # <dist-dir> <target>
  local dist="$1" target="$2" tmp name sums
  tmp="$(mktemp -d)"
  sums="$(curl -fsSL "https://nodejs.org/dist/$dist/SHASUMS256.txt")"
  name="$(printf '%s\n' "$sums" | awk '/linux-arm64\.tar\.xz$/ {print $2; exit}')"
  [ -n "$name" ] || { echo "node_release_missing: $dist" >&2; exit 3; }
  if [ -x "$target/bin/node" ] && [ "$(cat "$target/.release" 2>/dev/null)" = "$name" ]; then
    rm -rf "$tmp"; return
  fi
  curl -fsSL -o "$tmp/$name" "https://nodejs.org/dist/$dist/$name"
  (cd "$tmp" && printf '%s\n' "$sums" | grep " $name\$" | sha256sum -c --status) \
    || { echo "node_checksum_mismatch: $name" >&2; exit 4; }
  rm -rf "$target.new" && mkdir -p "$target.new"
  tar -xJf "$tmp/$name" -C "$target.new" --strip-components=1
  echo "$name" > "$target.new/.release"
  rm -rf "$target" && mv "$target.new" "$target" && rm -rf "$tmp"
}
node_install latest-v20.x /opt/node20
node_install latest-v22.x /opt/node22
node_install v26.11.1 /opt/node26

# CPython 3.12 from uv's verified standalone builds (Debian 13 ships 3.13 only).
if [ ! -x /opt/python3.12/bin/python3.12 ]; then
  [ -x /opt/uv/bin/uv ] || { python3 -m venv /opt/uv && /opt/uv/bin/pip install -q uv; }
  UV_PYTHON_INSTALL_DIR=/opt/uv-python /opt/uv/bin/uv python install 3.12 >/dev/null
  found="$(UV_PYTHON_INSTALL_DIR=/opt/uv-python /opt/uv/bin/uv python find 3.12)"
  mkdir -p /opt/python3.12/bin
  ln -sf "$found" /opt/python3.12/bin/python3.12 && ln -sf python3.12 /opt/python3.12/bin/python3
fi

for v in 20 22 26; do echo "TOOLCHAIN node$v $(/opt/node$v/bin/node --version)"; done
echo "TOOLCHAIN python3.12 $(/opt/python3.12/bin/python3.12 --version 2>&1)"
echo "TOOLCHAIN localci-python $(python3 --version 2>&1) pyyaml=$(python3 -c 'import yaml; print(yaml.__version__)')"
echo "TOOLCHAIN git $(git --version)"
