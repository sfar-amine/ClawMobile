# usage.status capture provenance

usage.status.json is copied exactly from Claude's PR core #48, OpenClaw2026.9.6 / S24 capture2026-10-10, cleaned on device before publication (Companion a841936, playbooks2ba0e72). accountEmail is the sanitized placeholder owner@example.invalid; projection must never expose even this field. Real measured call3.2s,637bytes (file27).

This fixture proves only usage.status. It does not qualify models.list, models.authStatus, config.get or usage.cost; these schemas and sanitized captures remain required. Synthetic boundary tests are labelled as such, not S24 captures.
