# Unix forward reconcile test uses fixture PID liveness — 25 October 2026

`LocalFilesystemForwardTests.test_crash_after_effect_is_reconciled_from_durable_unique_lease` failed deterministically in canonical CI on a Linux CI container: `check_and_reconcile(False)` returned 2 instead of 0. The receipt reported `forward_owner_identity_unavailable`. The fixture owner PID 4242 was a live host process (`kworker/0:2`) there, so after the fixture removed the owner identity, the real `os.kill(4242, 0)` succeeded and the guard correctly classified the owner as UNKNOWN rather than DEAD.

The test class now patches `guard.os.kill` with the same fixture already used by `ForwardLeaseTests`: a PID absent from the fixture identities raises `ProcessLookupError`. Production code is unchanged; the fail-closed UNKNOWN rule for unreadable identities is preserved and still covered.

Evidence: the full `installer/termux-lite/test-android-network-mutation-guard.py` suite passes (78 tests) on the same container where the failure reproduced three times. Rollback is a normal revert of this test-only commit. No route, capability, MCP contract or S24 state changes.
