# Capability Decision Contract V2 runtime — deployment closure — 2026-10-08

Runtime functional source `7cdb7cb366d97b13d12adb415a3df2e883136c65` is published on `runtime/samantha-companion-private`, installed in the canonical checkout and active through Tier-0 release `20261008T231005-d3beb769`. The release source commit equals the published runtime commit and the active `model-fast-path.py` / `claw-capability.py` hashes match the canonical repo. Tier-0 soak is stable with zero bad samples.

The Companion process runs with `CLAW_UI_PLAYBOOKS_ROOT=~/.openclaw/runtime-ui-playbooks/current`, which resolves to immutable published UI commit `4deae593178e2ae2e85d13d4e13952f93cd9d0e3`. The installed OpenClaw plugin hash matches the runtime source build. Gateway and Companion are online; ADB is ready.

Live no-effect V2 acceptance completed a Known battery read through one `EXECUTE` DecisionEnvelope, emitted a bounded `CLARIFY` DecisionEnvelope for ambiguous Maxit wording, and resolved a linked clarification reply into a child `EXECUTE` decision for an Orange offer read. All runs completed through `capability_first`; the three request/client identities have zero model transcript rows. No payment handoff or financial effect was executed.
