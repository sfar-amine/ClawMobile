# Samantha private text/voice conversation continuity

Amine approved one conversation across text and voice, transcript history and reopening after application close on 2026-10-03 (context 834). Raw audio is never persisted by this feature. This patch remains private.

The existing Companion runs registry holds voice transcript records with the same sessionId as text. GET /v1/sessions/:id/turns assembles the selected conversation (existing 40-turn app window) using at most one Gateway history read; no per-turn Gateway loop. POST /v1/sessions/:id/voice-turns only stores text and never executes a request. Its stable turn ID and monotonically increasing revision make checkpoint retries idempotent; stale updates cannot replace newer ones. Completed/interrupted records cannot be reopened by delayed packets. Unknown fields including audio are rejected.

Writes use the existing registry, serialized and replaced atomically; missing files initialize normally, corruption remains an error. Session deletion/archive rejects delayed transcript checkpoints. Legacy registry rows and legacy/SQLite Gateway readers remain supported. Text results are cached in the same existing rows after verified completion.

Before a new text request, voice turns since the preceding text request enter its provider prompt as historical data, explicitly never a command to replay. Voice restores ordered user/model roles from the same history through clientContent, turnComplete=false. Provider chat histories remain separate; the owner conversation identifier and transcript projection are shared. There is no new backend, database, daemon or scheduler.

Android stores only the selected identifier and an unacknowledged text checkpoint queue in its existing private preferences. This queue is removed after Companion acknowledgement, reuses the same IDs after process death, and marks unfinished turns interrupted. It is a delivery buffer, not another conversation archive. A new text action or voice connection waits for transcript synchronization; uncertain actions are never automatically replayed.

Validation: TypeScript compilation; existing runs, SQLite compatibility (7 assertions), Claw Live suites; conversation continuity suite covering context, module reload, stale replay, invalid/audio payloads, isolation, concurrent writes, deleted sessions and corrupt registry. Physical Android acceptance is recorded separately after installation.

Rollback: restore the pre-deployment source and compiled payload from the scoped private backup after stopping only Companion through its supervisor. New voice rows are additive; do not delete user history. Do not reset the private checkout to public main. The older standalone SQLite overlay installer is not the rollback mechanism for this newer revision.
