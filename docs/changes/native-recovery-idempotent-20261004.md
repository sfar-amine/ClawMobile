# Native recovery idempotent healthy fast-path — 2026-10-04

`native-recovery-entrypoint.py repair` now reads the current critical capability/Slack snapshot before any recovery mutation. If the runtime is already healthy it returns `mutation=none_already_healthy` and does not invoke network reconciliation or Tier0 bootstrap. Actual degraded states keep the existing bounded repair path.
