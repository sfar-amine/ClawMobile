# Temporary Android network mutation safety

## Purpose
Prevent temporary debugging or interception changes from outliving their task and breaking the S24 network.

## Contract
- Prefer app-scoped capture/VPN mechanisms over Android global proxy settings.
- A global proxy is never a casual discovery mechanism; use it only when the task explicitly requires it.
- Before any Claw-owned temporary network mutation, capture exact key presence and value.
- Restore an originally absent key with `settings delete`; never restore absence by writing the literal value `null`.
- A successful trap/cleanup command is not evidence of restoration. Re-read and compare the final state.
- Restoration is idempotent: settings already equal to the snapshot are not rewritten. Android's inactive proxy sentinels `http_proxy=:0` and `global_http_proxy_port=0` are treated as clean, not as an active unmanaged proxy. If an exact previously-empty setting would need to be recreated and Android shell cannot represent it safely, fail closed and retain the lease for verification rather than approximating the value.
- Verify an independent application-level network request after restoration.
- Never auto-remove an unmanaged proxy that Claw did not create.

## Guard
`installer/termux-lite/android-network-mutation-guard.py` owns temporary network-mutation leases.
It snapshots all Android global proxy keys before mutation and restores them exactly afterward. For `with-wifi-off`, the same lease also snapshots whether Wi‑Fi was enabled, disables Wi‑Fi only when necessary, and restores/verifies the exact initial Wi‑Fi state after the child command. A stale owned lease is automatically reconciled by the existing Health Manager loop, including Wi‑Fi restoration when the lease contains that snapshot.
An unmanaged proxy is reported as degraded rather than silently overwritten.

## Required checks
The guard covers:
- `http_proxy`
- `global_http_proxy_host`
- `global_http_proxy_port`
- `global_http_proxy_exclusion_list`
- `global_proxy_pac_url`

The health receipt is `~/.openclaw/health/network-mutation-safety.json`.
Health Manager treats a persistent failure as component `network_safety` and uses the existing incident lifecycle.

## Safe invocation
Use:
- proxy lease: `android-network-mutation-guard.py with-global-proxy HOST:PORT --purpose <reason> -- <command...>`
- temporary Wi‑Fi OFF: `android-network-mutation-guard.py with-wifi-off --purpose <reason> -- <command...>`

`with-wifi-off` is intended for workflows such as Orange/Maxit that require mobile-network execution. It does not change the default SIM or mobile-data setting and restores Wi‑Fi only to the state observed at entry.

Do not issue raw `settings put global http_proxy ...` in Claw experiments.
For any other temporary system setting outside this helper, apply the same snapshot / exact-restore / post-check contract before mutation.
