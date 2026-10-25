# Real SDK preparation metadata —25October2026

Read-only observations from the installed OpenClaw2026.9.6 SDK and existing `/data/data/com.termux/files/usr/tmp/openclaw/openclaw-2026-10-25.log`. Only the two known public science-question run identities, stage names/durations, process identities and closed method metadata were projected. No prompt, answer, private event body or secret. Neither a new model turn nor a metadata preload was executed on the S24 for this source preparation.

The first run's overall preparation reports8510ms for core-plugin-tools while its detailed nested tracker reports8509ms; plugin-tools consumes8298ms. The second reports6855ms and6742ms. Different PIDs prevent a measured same-process cold/warm claim. Missing low-latency warning records are not fabricated warm timings.

Program contracts checked on the actual installed SDK:

- `tools-catalog-DfeQLIrN.mjs` SHA256cd38996f746e1101129729eb9253a7ad1e3bf2f9973316554f2073d1f052c9d3: tools.catalog handler, agent selection, includePlugins, registry/factory preparation; no agent/chat.send/tool.execute call.
- `tools-CvXdkvXK.mjs` SHA256a31975686eddc6a779865ff896b145b3b41bd7c659ac21761448da6861b0d926: missing registry load before factory stopwatch, same SDK registry owner.
- `builtin-openclaw-q1hiFm14.mjs` SHA256e4504516aef56cd293e11369e420148c5ad60c80e60128ed64bfb57fb7239e25: real preparation stage tracker.
- `method-scopes-C7g7eSZh.mjs:662–665`: tools.catalog is operator.read.
- `bootstrap-cache-CzPKOgYA.mjs` SHA256e8e47f961b451a3a7ad879ab625d91f3ba6ab3855b17c30bb74fc3e391452fb8:64bootstrap snapshots, distinct from plugin registry128entries in registry-lifecycle.

The offline RPC fixture in the Node test is explicitly synthetic and is not a captured S24 catalogue response or measured performance gain. The prewarm-to-agent cache identity and actual user-turn gain must be measured on the next already planned real recipe.
