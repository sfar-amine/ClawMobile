# Local Samantha Control read façade

Private Companion extension; no second runtime or public API.

GET /v1/extensions/samantha-control/{snapshot,activity,requests,automations,intelligence,health,situations}
GET /v1/extensions/samantha-control/activity/stream

The routes always require loopback and reject browser-origin requests. Other methods return 405. Snapshot collection invokes the existing private playbooks projection reporting.control_snapshot. Errors return a fixed control_unavailable envelope, never raw process output. Collection is bounded and cancellable.

Activity uses the existing semantic claw-live readers through --control-json and --control-history. Structured events expose bounded metadata only: timestamp, human title, category, state, observed executor/provider and safe detail labels. Commands, transcript text, contacts, raw keys and payloads are excluded entirely. The terminal mode and the unrelated voice clawLive.ts extension retain their existing behavior.

An SSE connection owns its short-lived read process and process group. Closing the HTTP request/response closes the stream and terminates its readers, including tail children. No persistent subscriber is started with Companion. Activity performs no ADB foreground observation or surface-state writes. Readiness and keepalives are transport metadata, not fabricated business events.

Candidate validation: TypeScript compiles; six Python event-boundary tests and seven isolated local HTTP checks pass, including a real event and process cleanup. Full private source publication and installed-runtime acceptance remain tracked in playbooks docs/work/samantha-android/22_CONTROL_ANDROID.md.
