# AI gate reached through the Companion — 27 October 2026

On 27/10 at 22:27 Tunis the Companion died while the Gateway kept running. For 15 minutes the health manager wrote `service=companion state=ai_gate_refused action=wait retry_in_s=60` and never restarted it. Amine had to start it by hand.

Why: the immune gate reaches its models through the Companion (`127.0.0.1:8765/v1/intent/interpret`), not through the Gateway. With the Companion gone, every gate model call was `unavailable` (Sol, Luna and Gemini free in `models.db`). The fix of the morning (#444) assumed the gate depended on the Gateway, so it only repaired directly when the Gateway was also down.

What changes:

1. `samantha-health-manager.sh`: when the gate refuses and no Companion process exists, the existing bounded repair runs directly (same lease, restart budget and canonical mode), whatever the Gateway state. Log: `service=companion action=direct_repair reason=ai_gate_unreachable`. A live Companion is never replaced without the AI.
2. `samantha-root-guardian.sh`: `gate_reachable` probes the Companion port instead of the Gateway `/healthz`. A missing supervisor is started directly when the Companion does not answer, at most once per 60 s.

Tests: one new case in `test-health-deploy-lock.py` and one in `test-root-guardian-gate.py`, both failing on the previous scripts. Rollback: revert this commit.
