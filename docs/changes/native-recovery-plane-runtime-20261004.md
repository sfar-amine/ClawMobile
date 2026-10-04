# Native recovery Tier0 entrypoint — 2026-10-04

`native-recovery-entrypoint.py` is a fixed deterministic recovery surface installed under `~/.openclaw/tier0/bin`. It accepts only `health` and `repair`, uses the existing Tier0/Health Manager/network guard, serializes repair with a lock, respects Tier0 emergency stop, bounds waits, and writes one local receipt. It never accepts a shell command, model prompt, workflow or business action.

The Tier0 installer now includes this entrypoint and enables Termux's documented `allow-external-apps=true` gate with backup/preserve semantics. The existing critical-capability list is preserved. No new daemon, scheduler, memory store or recovery owner is introduced.

Live shadow acceptance from the real Samantha app reached this entrypoint through Termux `RUN_COMMAND` and correctly returned `deferred / tier0_emergency_stop`, proving the safety boundary while another chantier owned the stop.
