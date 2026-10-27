# Root guardian with an unreachable AI gate — 27 October 2026

On 27/10 at 14:00 the S24 was rebooted. For 50 minutes the root guardian started neither the health manager nor the incident orchestrator, and its log said nothing.

Why: each restore of a missing supervisor goes through the immune gate. The gate reaches its models only through the Gateway (port 18789). The Gateway belongs to the Companion, which only the health manager starts. With the health manager missing the gate always answered `unavailable` and the guardian refused silently. Samantha could not come back after a reboot without a manual start.

What changes in `samantha-root-guardian.sh` (approved by Amine on 27/10):

1. The gate is still asked first, every round.
2. If it refuses, the supervisor is missing and the Gateway does not answer `/healthz`, the guardian starts it with the existing bounded start (lock, release root, verification), at most once per 60 s per supervisor. Log: `event=<name>-missing action=direct_start reason=ai_gate_unreachable`.
3. With the Gateway up (for example no internet), the AI keeps the decision. A supervisor running from another release is never replaced without the AI.
4. A refusal is logged once (`action=wait reason=ai_gate_refused`) until the supervisor is healthy again.

The same loop held the Companion: after the health manager was started by hand at 14:55, the Companion stayed down, because its repair is gated by the same AI gate. In `samantha-health-manager.sh`, when the gate refuses, there is no Companion process and the Gateway does not answer, the existing bounded repair runs directly (same lease, restart budget of 3 per hour and canonical mode). Log: `service=companion action=direct_repair reason=ai_gate_unreachable`. A refusal is logged (`state=ai_gate_refused action=wait`) and retried after 60 s. A live Companion is never replaced without the AI.

Tests: `test-health-deploy-lock.py` (3 new cases) and `test-root-guardian-gate.py` (registered in CI), 4 cases, all failing on the previous guardian. Rollback: revert this commit.
