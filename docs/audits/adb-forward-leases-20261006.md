# Typed ADB forward leases — 2026-10-06

Status at source qualification: implementation and protocol tests qualified locally and on S24; private publication, immutable Tier0 activation and the real QA consumer proof are separate pending steps. No real ADB forward, proxy, UI or runtime was changed by these unit tests.

## Scope and authority

The existing `device.network_safety` helper owns the new `adb_forward` lease type in `~/.openclaw/network-mutation/leases`. Existing proxy leases without a type remain supported; newly created proxy leases identify `global_proxy`. No new daemon, scheduler, orchestration store or QA-owned network ledger is introduced. The existing health-manager reconciliation remains the recovery owner. Typed forward journals remain in their original lease files, with at most 64 state-transition events and separate renewal count/time.

The private branch is `feature/qa-adb-forward-lease-20261006`. The original isolated base was `9559da87fe96cab45fd00bfe17f95279423a5eca`; integration must retain subsequent private runtime changes, first observed at `4e299bd808ced347252f3856898ab5160522c8cf`, then integrated by fast-forward to the private remote and active runtime source `051c0c26e3a498def60b1bc1a828fc3844c359ba`. The private remote is `samantha-private`, targeting `sfar-amine/samantha-core` and branch `runtime/samantha-companion-private`. No public ClawMobile remote is a delivery target.

## Python contract

```python
acquire_adb_forward(serial, local="tcp:0", remote="localabstract:chrome_devtools_remote",
                    purpose="temporary-adb-forward", owner_pid=None, lease_id=None)
inspect_adb_forward(lease_id)
renew_adb_forward(lease_id, owner_pid=None)
release_adb_forward(lease_id, owner_pid=None)
```

The campaign worker is the owner (default current Python PID). Persist one UUID as 32 lowercase hexadecimal characters before acquisition and use the same UUID for status/recovery: repeating acquire with that identity only observes the existing lease. A different request or process birth with the same UUID raises `ValueError`. The CLI requires explicit `--lease-id` and `--owner-pid` for acquisition and explicit owner for renew/release, because a short-lived CLI subprocess must not become the campaign owner.

Consume only `ready == true`, `verified == true` and `state` equal to `ACTIVE` or `REUSED`; use the returned `endpoint`. A normal nonready result is not an exception and never authorizes UI input or automatic recreation. Invalid/owner-conflicting arguments raise `ValueError`; initial observation/lock failures can raise `RuntimeError`, OS or subprocess exceptions. CLI failures print a bounded generic JSON result without raw ADB output. Always call release in worker cleanup and retain its actual `cleanup_verified` result.

Resolve the installed helper through `python3 ~/.openclaw/tier0/bin/tier0-control.py root`, then append `android-network-mutation-guard.py`. Do not import a candidate source worktree or mutate the currently active release. The old installed helper lacks these APIs until activation is complete.

## Durable lifecycle and restoration

A lock in the existing network-mutation authority covers inspection, durable state writes and each ADB mutation. Writes use file and directory fsync, atomic replacement and mode 0600. The lease records exact ADB client/server configuration, serial, local and remote identities and process start ticks plus boot identity. An unreadable live process identity is UNKNOWN, not proof of death. S24 `/proc/self/stat` and boot identity readability were checked without disclosing their values.

For `tcp:0`, the helper reuses an existing unique matching forward or selects and briefly reserves a concrete loopback port. That exact port is durably recorded before releasing the reservation and issuing `forward --no-rebind`. Multiple matching preexisting forwards block; a foreign mapping at a requested port blocks without mutation or cleanup debt. Preexisting mappings are never owned or removed.

A successful create acknowledgment is persisted before the follow-up observation. A lost acknowledgment, including a crash after effect but before persistence, stays unproven even if its triple subsequently matches. No creation or removal with an unknown result is replayed. Cleanup removes only a previously acknowledged, still-owned mapping with exact current identity and an originally absent local mapping. Any observed divergence revokes ownership permanently; a later identical tuple does not restore it. Absent owned mappings close with verified restoration. Repointed/unproven/unobservable mappings remain preserved or verification-required.

The lease TTL is 900 seconds by default, measured from `last_renewed_at`, not campaign birth. The live worker must renew before each bounded step/capture, well before TTL. Renewal after expiry is refused; worker input must stop on nonready. The existing reconciler removes a proven matching forward after owner death/replacement or lease expiry. A campaign lasting beyond 900 seconds remains active through renewals; no new scheduler is needed. Terminal no-mutation and closed leases do not legitimize global proxy state. Active forward leases also never legitimize an unmanaged global proxy.

ADB `--remove` accepts a local endpoint, not an atomic expected-serial/remote/generation condition. The shared guard lock protects cooperating callers and all observed divergences are preserved. It cannot guarantee compare-and-delete against an unrelated raw ADB rebind precisely between observation and removal, or an unobserved same-tuple replacement. Callers must route temporary forwards through this authority; no stronger atomic property is claimed.

## Verification and remaining live proof

`python3 installer/termux-lite/test-android-network-mutation-guard.py` runs 29 tests: the seven existing proxy/background tests and 22 fake ADB tests. Cases include durable creation/removal intent, locked mutation, exact/unrelated mappings, dynamic concrete port, idempotent same-ID acquisition, preexisting/ambiguous forwards, unknown creation, crash before acknowledgment, acknowledged owner death, unavailable observations, observed divergence/ABA preservation, renewal beyond initial TTL, PID reuse, unreadable owner, unknown removal without replay, server-identity changes, malformed requests, unknown lease types and global-proxy coexistence. The fixture replaces every ADB call; it is protocol qualification, not a real UI or network acceptance result.

After activation, the existing QA consumer must perform one authorized real acquisition/use/release, verify its own created forward is absent, preserve unrelated/preexisting state, and report both the consumer receipt and cleanup receipt. Root owns this real acceptance and activation.

## Private immutable activation handoff

Follow `docs/audits/termux-background-network-hardening-20261004.md`: preserve the five critical capabilities and exact private source commit. First review/publish the scoped private commit, reconcile newer private runtime changes in isolation, and ensure the source worktree is clean. Do not package an old full source tree over concurrent runtime changes.

Commands below are a handoff, not executed by this qualification. Root re-observes the active release and source immediately before execution. The observed current policy is soak 120 seconds, startup grace 90 seconds and the five critical capabilities below. The existing Tier0 `package` creates a new immutable release; `promote` swaps the pointer and triggers its existing core restart/soak mechanism.

```bash
GUARD_SOURCE="$HOME/.openclaw/worktrees/qa-adb-forward-lease-20261006"
GUARD_COMMIT="$(git -C "$GUARD_SOURCE" rev-parse HEAD)"
GUARD_RELEASE="20261006-adb-forward-${GUARD_COMMIT:0:12}"
python3 "$HOME/.openclaw/tier0/bin/tier0-control.py" package   --source "$GUARD_SOURCE/installer/termux-lite"   --source-commit "$GUARD_COMMIT" --release-id "$GUARD_RELEASE"   --soak-seconds 120 --startup-grace-seconds 90   --critical-capability immune.root_guardian   --critical-capability immune.health_manager   --critical-capability immune.incident_orchestrator   --critical-capability device.adb --critical-capability remote_desktop
python3 "$HOME/.openclaw/tier0/bin/tier0-control.py" promote "$GUARD_RELEASE"
```

Observe the existing soak/status in bounded intervals, verify manifest source commit and installed helper hash, then perform the real consumer proof. If the active manifest carries a product manifest, preserve it with the existing package `--product-manifest` option. Rollback uses the existing previous immutable LKG and rollback/restart workflow; source integration or package creation alone is not live acceptance. Do not edit an immutable release in place.

## MCP owner parity assessment

The six existing primitives (`claw_context`, `claw_resolve`, `claw_execute`, `claw_exec`, `claw_status`, `claw_artifact_read`) have no interface/schema/adapter impact from this internal lease extension. No gateway or Companion contract is modified. The existing Graph owner-palette check provides the shared admission check; its fresh result is recorded in the change note. The QA capability itself has a separate six-primitive assessment in its ui-playbooks delivery.
