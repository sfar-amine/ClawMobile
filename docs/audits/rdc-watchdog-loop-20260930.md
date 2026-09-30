# RDC watchdog loop hardening — 2026-09-30

## Incident
Remote Desktop Commander entered a repeated repair loop after its watchdog kept a cwd inside a deleted worktree. Every child restart inherited that deleted cwd and Node failed with uv_cwd ENOENT.

## Fix
- The watchdog moves to the stable Termux home before locking or launching Desktop Commander.
- One deterministic repair cycle remains bounded to two restart attempts.
- After failure the circuit opens; subsequent watchdog passes observe only and do not replay restart mutations.
- The watchdog opens a canonical remote_desktop incident in the existing Incident Orchestrator.
- The orchestrator now routes remote_desktop through the existing Sol-first/Luna-fallback shadow diagnosis.
- diagnostics.collect_more is bounded to one extra collection; model diagnosis failures are bounded to two.
- runtime.managed_repair maps only to the predefined stable-cwd Desktop Commander restart and readiness checks.
- The Desktop Commander process log is compacted before repair when it exceeds 4 MiB.

## Acceptance
Targeted shell and Python tests cover stable cwd, circuit opening, incident routing, bounded model diagnosis, log bounding and managed repair routing. A live provider canary returned GPT-5.6 Sol with diagnostics.collect_more.
