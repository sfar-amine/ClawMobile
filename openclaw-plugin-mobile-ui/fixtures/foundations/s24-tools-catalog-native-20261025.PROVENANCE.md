# Native metadata catalogue projection, 25 October 2026

Root performed exactly one official `openclaw gateway call tools.catalog --json --timeout 20000 --params` request with `agentId:main, includePlugins:true` on the S24. The existing private acceptance receipt is `~/.openclaw/autonomous-engineering/acceptance/refonte-parcours-unique-20261025/catalog-native-once-v1.json`. The source agent read this receipt only; no replay was made.

This fixture retains only timestamps, request method/parameters, exit status and the sixteen group IDs/sources/tool counts. Tool descriptions, parameters, schemas, credentials and conversations are excluded. The mobile-ui plugin has 42 tools in this catalogue. Duration12636.97ms includes CLI startup; this single observation proves neither per-plugin preparation cost nor a warm-cache gain or identical subsequent agent cache key. No model turn or tool execution was requested.
