# The helper always receives its private input — 26 October 2026 (REQ-3278)

On 26/10 the S24 sent « Le suivi de conversation est indisponible. » to the Pulse room three times: at 11:29, 11:43 and 13:21 UTC. Each time, the Gateway restarted right afterwards.

The cause: the Gateway runs with `NODE_OPTIONS=-r glibc-compat.js`. This Termux shim replaces `child_process.execFile` but drops its promise form (`util.promisify.custom`). As a result, `promisify(execFile)` returned a promise with no `.child`. The sequence was then:

1. Reading `child.stdin` threw before the private input was written, which produced the `coordinator_unavailable` reply.
2. The Python helper waited 2 s for its input, stopped with `native_pulse_input_timeout` and exited with code 1.
3. Nothing was awaiting that promise any more. Its rejection was unhandled and restarted the Gateway; stability bundles were recorded at 11:29:10Z, 11:43:12Z and 13:21:02Z.

The failure was reproduced on the S24 with the deployed dist and Node 24.21.0.

- `runCapabilityHelperProcess` now starts the helper with the callback form of `execFile`. That form returns the child on every Node build and puts `stdout`/`stderr` on the error. This is the same fix already used for the same cause in `gemini-public-synthesis.mjs` on 17/10.
- The argv, environment, timeouts, process group and private-input contract are unchanged.

Test: `test-helper-process-termux-shim.cjs` loads the real shim. It checks that the input reaches the helper, that a failure is caught, and that no rejection is orphaned. It fails without the fix with the S24 error. The transport suites, C16 (42/42) and C18 (23/23) pass. Rollback: revert this commit.
