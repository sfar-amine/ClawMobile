# Tier0 reload ignores an already-exited (defunct) watchdog child — 25 October 2026

The first S24 deployment of #420 (`cab55127`, receipt `companion-20261025T191201`) rolled back with `runtime_sync_failed`. `install-tier0-control.py` raised `watchdog_busy_no_reload`. The S24 process table at 19:19 showed why. The resident watchdog (PID 18631, up 7 days, started before #420) had exactly one child, `[tier0-bootstrap] <defunct>`, which had exited 3 h 23 min earlier. It had never been reaped, because the watchdog `Popen()`s `tier0-bootstrap.sh --restart-core` without waiting for it. The previous release (`d87bd249`) was restored by the existing deploy owner, and the Companion answered again.

A zombie has finished: no decision or effect is in flight, so killing its parent cannot turn anything into an uncertain replay. `watchdog_has_children` now skips children in kernel state `Z`. A running child of the same verified watchdog identity still blocks the reload. A child of a recycled PID still never authorizes anything. The `/proc` root is injectable for tests only; production reads `/proc` as before.

Evidence: three new offline tests in `test-tier0-activation-readiness.py`, built from the observed S24 values (PID, comm, state, parent):
- the defunct child alone does not block;
- a running sibling still blocks;
- a recycled watchdog PID does not block.

The defunct case fails without the fix. All 18 tests in the file pass. SOAK 300 s, startup grace, readiness, rollback and critical capabilities are unchanged. No new daemon, store, retry, route or capability.

Known limit, not fixed here: the watchdog still does not reap its bootstrap children, so defunct entries accumulate until it is replaced. That is harmless to the reload after this fix, and is left for a separate change. Rollback: revert this commit; the previous behavior (refuse on any child, including zombies) returns.
