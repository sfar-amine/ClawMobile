# Tier0 — no rollback from two reads of one startup sample

A single unchanged health timestamp could increment the soak failure counter twice. Tier0 now consumes distinct producer samples, keeps the existing two-bad-sample rollback and preserves its exact bounded evidence. Promotion also waits for Gateway readiness when the plugin did not change; an empty HTTP200 is not readiness.

Captured chronology, uncertainty about the overwritten historical sample, bounded behaviour, registered tests and rollback are in [the contract](../work/samantha-runtime/contracts/tier0-distinct-health-20261018.md). No new route/capability/store/service or payment/live-voice/environment-D change. CI proof must be quoted in the PR for its exact head and number; local simulation does not replace Claude's physical five-deployment recipe.
