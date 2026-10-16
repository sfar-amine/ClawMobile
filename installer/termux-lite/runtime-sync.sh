#!/data/data/com.termux/files/usr/bin/bash
# One commit, one deploy, no drift (S24 12/10). The Companion runs the checkout directly; every other copy the
# phone executes or loads is brought to the same commit by its existing owner, then proved:
#   - Gateway plugin (~/.openclaw/extensions): clawmobile_install_plugin (lib.sh), then a graceful Gateway restart;
#   - Tier0 release (~/.openclaw/releases/current, serves model-fast-path.py): install-tier0-control.py --apply, pruned;
#   - deploy tools (~/.openclaw/tools): companion-deploy.sh / companion-acceptance.py replaced atomically;
#   - agent rules: rooms (project-room.py / pulse-room.py rules) and plain contacts (contacts-agent.md).
# --check changes nothing and also proves what a deploy does not own: the playbooks interaction rules (no-invention
# rule included) and the Gateway's before_dispatch contract that the fast paths rely on (S24 12/10: inbound_claim
# turned out to fire only for plugin-bound conversations).
#   runtime-sync.sh <commit>       one JSON line; exit 0 only when every copy matches the checkout
#   runtime-sync.sh --check [<c>]  one JSON line {ok, drift[]}; exit 1 on any drift (health manager, every 30 min)
set -uo pipefail
mode=sync; [ "${1:-}" = --check ] && { mode=check; shift; }
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# From the checkout: its repository. From a Tier0 release copy (health manager): the deployed checkout.
if [ -e "$ROOT/../../.git" ]; then REPO="$(CDPATH= cd -- "$ROOT/../.." && pwd)"; else REPO="${CLAW_CORE_REPO:-$HOME/ClawMobile}"; fi
SRC="$REPO/installer/termux-lite"
PLUGIN="$REPO/openclaw-plugin-mobile-ui"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
EXT="$STATE_DIR/extensions/openclaw-plugin-mobile-ui"
CURRENT="$HOME/.openclaw/releases/current"
TOOLS="$STATE_DIR/tools"
CONTACTS="$STATE_DIR/workspace-contacts"
PLAYBOOK_RULES="${RUNTIME_SYNC_PLAYBOOK_RULES:-$HOME/.openclaw/runtime-ui-playbooks/current/tools/install_interaction_rules.py}"
OPENCLAW_DIST="${RUNTIME_SYNC_OPENCLAW_DIST:-/data/data/com.termux/files/usr/lib/node_modules/openclaw/dist}"
COMPANION="${RUNTIME_SYNC_COMPANION_URL:-http://127.0.0.1:8765}"
KEEP_RELEASES="${RUNTIME_SYNC_KEEP_RELEASES:-5}"
head="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)"
commit="${1:-$head}"; [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 [--check] <full commit>" >&2; exit 2; }
[ "$head" = "$commit" ] || { echo '{"ok":false,"reason":"checkout_not_at_commit"}'; exit 3; }

plugin=unchanged; release=unchanged; gateway=unchanged; tools=unchanged; rules=unchanged
fail(){ printf '{"ok":false,"reason":"%s","plugin":"%s","release":"%s","gateway":"%s","tools":"%s","rules":"%s"}\n' "$1" "$plugin" "$release" "$gateway" "$tools" "$rules"; exit 1; }
same_plugin(){ [ -d "$EXT" ] && diff -rq --exclude=node_modules --exclude=.git --exclude=.openclaw-plugin-installed-lite.stamp "$PLUGIN" "$EXT" >/dev/null 2>&1; }
release_commit(){ python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("source_commit") or "")
except (OSError,ValueError): print("")' "$CURRENT/manifest.json"; }
stale_tools(){ for name in companion-deploy.sh companion-acceptance.py; do [ -f "$TOOLS/$name" ] && ! cmp -s "$SRC/$name" "$TOOLS/$name" && echo "$name"; done; }
contacts_stale(){ [ -d "$CONTACTS" ] && ! cmp -s "$SRC/contacts-agent.md" "$CONTACTS/AGENTS.md"; }
dispatch_contract(){ [ -d "$OPENCLAW_DIST" ] || return 0; grep -lq "runBeforeDispatch" "$OPENCLAW_DIST"/dispatch-from-config-*.mjs 2>/dev/null; }

if [ "$mode" = check ]; then
  drift=()
  same_plugin || drift+=(gateway_plugin)
  [ "$(release_commit)" = "$commit" ] || drift+=(tier0_release)
  for name in $(stale_tools); do drift+=("tool:$name"); done
  python3 "$SRC/project-room.py" rules --check >/dev/null 2>&1 || drift+=(rules:project_room)
  python3 "$SRC/pulse-room.py" rules --check >/dev/null 2>&1 || drift+=(rules:pulse_room)
  contacts_stale && drift+=(rules:contacts)
  # The playbooks own their rules installer; a planned change means OPERATING_RULES.md no longer carries them.
  if [ -f "$PLAYBOOK_RULES" ]; then
    out=$(python3 "$PLAYBOOK_RULES" 2>/dev/null) || drift+=(rules:operating_unreadable)
    case "$out" in *'"planned"'*) drift+=(rules:operating);; esac
  fi
  dispatch_contract || drift+=(openclaw:before_dispatch_missing)
  python3 "$SRC/openclaw-compat/whatsapp-network-recovery.py" --check >/dev/null 2>&1 || drift+=(openclaw:whatsapp_network_recovery)
  list=$(printf '"%s",' "${drift[@]}"); list="[${list%,}]"; [ "${#drift[@]}" -eq 0 ] && list='[]'
  printf '{"ok":%s,"commit":"%s","drift":%s}\n' "$([ "${#drift[@]}" -eq 0 ] && echo true || echo false)" "$commit" "$list"
  [ "${#drift[@]}" -eq 0 ]; exit $?
fi

dispatch_contract || fail openclaw_before_dispatch_missing
wa_patch=$(python3 "$SRC/openclaw-compat/whatsapp-network-recovery.py" --apply) || fail whatsapp_network_recovery_refused

# 1. Gateway plugin. Forced: after a rollback the restored dist is older than the install stamp.
if ! same_plugin; then
  ( . "$SRC/lib.sh" && CLAWMOBILE_TERMUX_FORCE_PLUGIN_INSTALL=1 clawmobile_install_plugin "$PLUGIN" ) >&2 || fail plugin_install_failed
  same_plugin || fail plugin_copy_differs
  plugin=synced
fi

# 2. The Gateway loads its plugin at start only: restart it gracefully when the plugin changed, then wait for it.
# Before the Tier0 promotion: a restart inside the soak window reads as a health regression (S24 12/10, 17:31 —
# release 5631a6aa rolled back to the 11/10 release after one bad sample).
if [ "$plugin" = synced ] || [[ "$wa_patch" == *'"applied"'* ]]; then
  curl -fsS -m 240 -X POST "$COMPANION/v1/runtime/restart" >/dev/null 2>&1 || fail gateway_restart_failed
  ready=0
  for _ in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$COMPANION/v1/control/health?contract=2" 2>/dev/null)" = 200 ] && { ready=1; break; }
    sleep "${RUNTIME_SYNC_POLL_S:-4}"
  done
  [ "$ready" = 1 ] || fail gateway_not_ready
  gateway=restarted
fi

# 3. Tier0 release (serves model-fast-path.py to the Gateway). Same commit already current: nothing to do.
if [ "$(release_commit)" != "$commit" ]; then
  python3 "$SRC/install-tier0-control.py" --apply >&2 || fail release_failed
  [ "$(release_commit)" = "$commit" ] || fail release_commit_differs
  python3 "$HOME/.openclaw/tier0/bin/tier0-control.py" prune --keep "$KEEP_RELEASES" --apply >&2 || true
  release=promoted
fi

# 4. Deploy tools: the next deploy runs the reviewed script, not a stale copy.
for name in $(stale_tools); do
  cp "$SRC/$name" "$TOOLS/.$name.next" && chmod 700 "$TOOLS/.$name.next" && mv -f "$TOOLS/.$name.next" "$TOOLS/$name" || fail tools_copy_failed
  tools=synced
done

# 5. Agent rules (no-invention rule, 12/10): rooms and plain contacts follow the commit, read at the next turn.
for script in project-room.py pulse-room.py; do
  out=$(python3 "$SRC/$script" rules 2>/dev/null) || fail "rules_failed:$script"
  case "$out" in *'"written"'*) rules=synced;; esac
done
if contacts_stale; then
  cp "$SRC/contacts-agent.md" "$CONTACTS/.AGENTS.md.next" && chmod 600 "$CONTACTS/.AGENTS.md.next" && mv -f "$CONTACTS/.AGENTS.md.next" "$CONTACTS/AGENTS.md" || fail rules_failed:contacts
  rules=synced
fi

same_plugin || fail plugin_copy_differs
[ "$(release_commit)" = "$commit" ] || fail release_commit_differs
python3 "$SRC/project-room.py" rules --check >/dev/null 2>&1 && python3 "$SRC/pulse-room.py" rules --check >/dev/null 2>&1 && ! contacts_stale || fail rules_differ
printf '{"ok":true,"commit":"%s","plugin":"%s","release":"%s","gateway":"%s","tools":"%s","rules":"%s"}\n' "$commit" "$plugin" "$release" "$gateway" "$tools" "$rules"
