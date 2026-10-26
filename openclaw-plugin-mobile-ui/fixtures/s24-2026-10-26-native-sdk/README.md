# Native SDK source captures — S24, 26 October 2026

Only installed public program source was read. No configuration, credentials, user messages or model call. Readonly receipts are retained privately under `/workspace/refonte-evidence/l3-sdk-*-receipt.json`, stable action `l3-sdk-queue-20261026`. Full source SHA256 and byte count identify each installed module. JSON stores exact function strings, not a reimplementation. Identities, clocks, messages and provider outcomes in tests are authored.

`google-schema-serializer.json` contains `@openclaw/ai`’s conversion through `parametersJsonSchema`, its generate-content builder and the installed `@google/genai` maps preserving that JSON branch. Transport/header/model effects are not exercised; backend validation stays covered by typed tools/admission tests.

`steering-loop.json` contains the installed AgentLoop’s exact checkpoint getter and loop. The test replaces only queue inputs and provider-stream boundaries; the actual loop must consume a new user message with the old context before `agent_end`. This proves the installed loop contract, not a live model decision.

The owner path inspected outside this fixture is `runActiveReplySteer` (`agent-runner.runtime-DH-TOu7I.mjs`, SHA f3e2b410e2089ac1c8834df5ef2ba7813cbbf2c5f36844861b1d8d8c446f2644) → exact-operation `messageInjectionV2` (`reply-run-registry.registry-BoHW1D6q.mjs`, SHA a88885150041cb420cc3d6677e26999c7342deef2c2e4ce862946a0ed5d34ef6) → `queueMessage`/`activeSession.steer` (`builtin-openclaw-q1hiFm14.mjs`, SHA e4504516aef56cd293e11369e420148c5ad60c80e60128ed64bfb57fb7239e25) → `agent.steer` (`resource-loader-v8341X6T.mjs`, SHA6c560f0d721601c1fe84f297f26f23e82e0bc6d29c5da05126a75b2b92719083) → AgentLoop. Different tool authority or closed finalization refuses steering and preserves followup. Already launched tools continue.

Queue default is `steer` in installed settings-5LUPsyZF.mjs, but explicit owner session/channel settings take precedence. Effective live mode and Stop consumed before agent_end remain recipe requirements. No `interrupt` default, self-abort relaxation, lexical pre-router, new store, or native SDK patch.
