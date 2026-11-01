# S24 31/10 — memory recall worker keep-alive

`compat/manager-cpu-worker-runtime-Egp8qeu_.mjs.gz` is the public OpenClaw 2026.9.6 module read on the S24
(`$PREFIX/lib/node_modules/openclaw/dist/`), byte-identical to the npm tarball file served by unpkg
(SHA-256 `43705d27…df9df7`, 4004 bytes). It is gzip -9 without timestamp.

`measurements.json` holds the cleaned timings behind the patch: Gateway log stage offsets of owner turns,
the Worker threads the Gateway started during one turn (inspector `NodeWorker` domain, local, closed after),
per-thread CPU ticks and the main-thread CPU profile summary. No transcript, prompt, config or credential.

Reading: the recall pool uses the `WorkerTaskPool` default `idleTimeoutMs` (60 s). A spoken turn after a pause
respawns `memory-search.worker.js` right after the tool catalogue, before the model starts.

`compat/sqlite-handle-lifecycle-dWd9h3ii.mjs.gz` is the public module that holds `SQLITE_IDLE_HANDLE_TTL_MS`, read on the
S24 and byte-identical in `openclaw@2026.10.9` (SHA-256 `147169a3…eb91a5`, 223 bytes). The settled bench of the evening
(`settled_bench_after_30min_keepalive`) shows warm turns at 3.7–5.1 s; the first turn after more than 30 min still paid a
closed agent-database handle (reopen → integrity quick_check, session write queued 2.6 s) and a respawned recall worker.
Both windows go to 12 h.

`compat/session-accessor-DLYTHSBj.mjs.gz` (01/11) is the public OpenClaw 2026.9.6 module that holds
`runSessionCollaborationWrite`, read on the S24 (`$PREFIX/lib/node_modules/openclaw/dist/`, SHA-256 `756d3a58…01155e`,
153 512 bytes) and byte-identical to the file of the npm tarball `openclaw-2026.9.6.tgz`. Its 2026.10.9 counterpart
(`session-accessor-C3ljJ974.mjs`, `c000b950…caa34`, same on the S24 candidate and in npm) is under
`../openclaw-2026.10.9-compat/`. Every agent turn records the session participant through this function: it takes the
agent write admission and, for a file-backed agent database, opens a one-shot SQLite Worker (spawn, open, bind, close)
before the write; the session writes of the same turn (`session.entry-replacements`, `session.maintenance.plan`) wait
behind it (Gateway log « slow SQLite session write », queue wait 1.4–3.4 s per turn; admission held ~2 s in the
31/10 profile, ~7.7 s on a fresh Gateway). The incognito branch of the same function already calls OpenClaw's native
writer `recordSessionParticipant`, which publishes the participant cache and the lifecycle event itself; the patch
routes the participant command of file-backed databases to that writer, inside the same admission and after the
database is admitted on its usual async path. `measurements.json` › `session_accessor_module` holds the hashes and
the observed figures; the gain itself is not measured yet.
