# Provenance — voice receipt latency

The metadata capture comes from the real S24 controlled native PCM recipe `qa-question-atomic-v1` on 25 October 2026, app QA `b18342bdb93c0978406bd4f6676dfb6eff4866f3`, Companion before the later d87bd249 deployment (the observation does not retain the exact earlier Companion SHA, so none is invented).

Authoritative native evidence references: `~/.openclaw/autonomous-engineering/acceptance/refonte-parcours-unique-20261025/qa413-question-v1-model-metadata.json`, `qa413-question-run-metadata-1792934573867622230.json`, `qa413-monitor-1792934509445581630.json`. The metadata was already copied to `/workspace/refonte-evidence/qa413-question-v1-observation.json` during the authorized read-only observation. This fixture retains only timings and run/receipt identity. No answer, prompt, private audio or account information is committed.

It proves the measured post-receipt gap exceeds 22 seconds. It does **not** contain provider generation-boundary frames and does not prove that virtual playback is the unique runtime cause. The new asynchronous handoff is tested against the documented provider protocol; its final live S24 recipe remains required.

Official provider source checked on 25 October 2026: Google `python-genai` commit `cb1408b06c573060f1593023ca320fde9a4fb5f6` (24 October 2026), `google/genai/types.py`: `Behavior.NON_BLOCKING`, `FunctionResponse.will_continue`, `FunctionResponseScheduling.SILENT`/`INTERRUPT`, and `LiveServerContent.generation_complete`. Gemini API supports the generator fields; Vertex AI explicitly does not support `will_continue`. Samantha uses the Gemini BidiGenerateContent API. Server acceptance and actual boundary ordering must still be verified live after canonical CI.
