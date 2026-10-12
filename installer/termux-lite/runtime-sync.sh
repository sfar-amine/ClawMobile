#!/data/data/com.termux/files/usr/bin/bash
# One commit, one deploy (S24 12/10): the Companion runs this checkout directly, but three other copies used to
# stay behind it. The WhatsApp Gateway loads its plugin from ~/.openclaw/extensions (frozen since 11/10: no Pulse
# room, no fast-path fixes on WhatsApp), resolves through model-fast-path.py of the Tier0 release
# (~/.openclaw/releases/current), and the deploy itself runs from ~/.openclaw/tools. This brings each of them
# to the checkout with its existing owner, then proves it:
#   - Gateway plugin: clawmobile_install_plugin (lib.sh), then a graceful Gateway restart (Companion route);
#   - Tier0 release:  install-tier0-control.py --apply (package + promote, soak and automatic rollback), pruned;
#   - deploy tools:   companion-deploy.sh / companion-acceptance.py replaced atomically (the running copy keeps its inode).
#   runtime-sync.sh <commit>   one JSON line on stdout; exit 0 only when every copy matches the checkout.
set -uo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO="$(CDPATH= cd -- "$ROOT/../.." && pwd)"
PLUGIN="$REPO/openclaw-plugin-mobile-ui"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
EXT="$STATE_DIR/extensions/openclaw-plugin-mobile-ui"
CURRENT="$HOME/.openclaw/releases/current"
TOOLS="$STATE_DIR/tools"
COMPANION="${RUNTIME_SYNC_COMPANION_URL:-http://127.0.0.1:8765}"
KEEP_RELEASES="${RUNTIME_SYNC_KEEP_RELEASES:-10}"
commit="${1:-}"; [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <full commit>" >&2; exit 2; }
[ "$(git -C "$REPO" rev-parse HEAD)" = "$commit" ] || { echo '{"ok":false,"reason":"checkout_not_at_commit"}'; exit 3; }

plugin=unchanged; release=unchanged; gateway=unchanged; tools=unchanged
fail(){ printf '{"ok":false,"reason":"%s","plugin":"%s","release":"%s","gateway":"%s","tools":"%s"}\n' "$1" "$plugin" "$release" "$gateway" "$tools"; exit 1; }
same_plugin(){ [ -d "$EXT" ] && diff -rq --exclude=node_modules --exclude=.git --exclude=.openclaw-plugin-installed-lite.stamp "$PLUGIN" "$EXT" >/dev/null 2>&1; }
release_commit(){ python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("source_commit") or "")
except (OSError,ValueError): print("")' "$CURRENT/manifest.json"; }

# 1. Gateway plugin. Forced: after a rollback the restored dist is older than the install stamp.
if ! same_plugin; then
  ( . "$ROOT/lib.sh" && CLAWMOBILE_TERMUX_FORCE_PLUGIN_INSTALL=1 clawmobile_install_plugin "$PLUGIN" ) >&2 || fail plugin_install_failed
  same_plugin || fail plugin_copy_differs
  plugin=synced
fi

# 2. Tier0 release (serves model-fast-path.py to the Gateway). Same commit already current: nothing to do.
if [ "$(release_commit)" != "$commit" ]; then
  python3 "$ROOT/install-tier0-control.py" --apply >&2 || fail release_failed
  [ "$(release_commit)" = "$commit" ] || fail release_commit_differs
  python3 "$HOME/.openclaw/tier0/bin/tier0-control.py" prune --keep "$KEEP_RELEASES" --apply >&2 || true
  release=promoted
fi

# 3. Deploy tools: the next deploy runs the reviewed script, not a stale copy.
for name in companion-deploy.sh companion-acceptance.py; do
  [ -f "$TOOLS/$name" ] || continue
  cmp -s "$ROOT/$name" "$TOOLS/$name" && continue
  cp "$ROOT/$name" "$TOOLS/.$name.next" && chmod 700 "$TOOLS/.$name.next" && mv -f "$TOOLS/.$name.next" "$TOOLS/$name" || fail tools_copy_failed
  tools=synced
done

# 4. The Gateway loads its plugin at start only: restart it gracefully when the plugin changed, then wait for it.
if [ "$plugin" = synced ]; then
  curl -fsS -m 240 -X POST "$COMPANION/v1/runtime/restart" >/dev/null 2>&1 || fail gateway_restart_failed
  ready=0
  for _ in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$COMPANION/v1/control/health?contract=2" 2>/dev/null)" = 200 ] && { ready=1; break; }
    sleep "${RUNTIME_SYNC_POLL_S:-4}"
  done
  [ "$ready" = 1 ] || fail gateway_not_ready
  gateway=restarted
fi

same_plugin || fail plugin_copy_differs
[ "$(release_commit)" = "$commit" ] || fail release_commit_differs
printf '{"ok":true,"commit":"%s","plugin":"%s","release":"%s","gateway":"%s","tools":"%s"}\n' "$commit" "$plugin" "$release" "$gateway" "$tools"
