# ADR — Shared Samantha conversation over existing Companion history

Status: accepted for the user-approved private S24 increment (context 834).

Decision: preserve one sessionId across text and voice. Extend the existing Companion runs registry with typed transcript rows and idempotent checkpoint revisions. Adapt the provider context at the existing text/voice boundaries. Keep a bounded Android acknowledgement buffer in existing private preferences. Reuse the existing 40-turn app history view and 100-row registry retention.

Rationale: current text goes through Gateway and current audio through Claw Live. Merging provider-native sessions is not available in the existing contract. The existing history is sufficient for owner-visible continuity without introducing a parallel memory/history service or replaying recorded actions.

Consequences: voice transcripts remain local text data in existing Companion history; audio remains transient. Partial/interrupted replies stay distinguishable. The provider may only see the retained conversation window; no unlimited memory claim. Existing cross-surface semantic Memory Core is unchanged. Approval and text action deduplication limits remain unchanged; transcript upsert idempotency does not imply action deduplication.

Reference: https://ai.google.dev/gemini-api/docs/live-api/capabilities (incremental content updates; consulted 2026-10-03).
