# ADR — Voice readback on one asynchronous provider call

Date: 25 October 2026. Status: proposed; source-only L4 preparation. Supersedes only the blocking delivery detail in ADR-20261025-voice-brain-delegation; the main brain remains the sole decision maker.

The real S24 recipe recorded a final brain receipt followed by a 22 second delay before useful voice audio. EVT-3239 reports longer delays, missing progress, and a spoken cancellation restarting reflection. The trace does not establish a unique delay cause. Source inspection exposes a concrete avoidable barrier: Android replies `running` to a BLOCKING Gemini call, discards the resulting generation and waits for `turnComplete` before requesting a separate receipt generation. Official Gemini types explain that `generationComplete` can precede `turnComplete` by a virtual audio-playback delay. Equating the two would misattribute late output and is rejected.

Keep the existing Warm/VoiceTurnProtocol owner. Only Android `ask_samantha` becomes NON_BLOCKING; clarification `clawmobile_capability` stays BLOCKING. Its correlated running acknowledgement uses `willContinue: true`, `scheduling: SILENT`. Progress lines and the final canonical receipt use the same provider call id with `scheduling: INTERRUPT`; progress keeps the generator open, the final receipt closes it. No extra business execution, text route, timer or store is added.

An interrupting response may retire an open generation. Quarantine every old PCM/text frame until its real `turnComplete`, including the separate `interrupted` marker. Do not interpret this transport interruption as cancellation of a business operation. Only then emit `outputResumed` for the next exact generation. If the boundary never arrives, do not fabricate completion or claim success. Owner speech, mute/epoch guards and closed sessions continue to refuse stale readbacks. The app may request the final receipt early only after the strict warm feature announcement; it never releases old audio merely because a request was sent.

The existing local waiting clips, 8/20-second follow-up deadlines, progress-card read owner and six-line bound remain. The shared budget is announced by `warmReady.turnBudgetMs` from `TURN_BUDGET_MS`; Android supports the canonical 30000 value and uses that same bounded fallback for older/malformed servers. It creates no second clock.

A new utterance may only continue an earlier unfinalized utterance. Once its transcript is final, a decision started or execution dispatched, never concatenate subsequent words to it. This lifecycle fence preserves cancellation words verbatim for the main brain, without any cancellation keyword route. A true business cancellation must be chosen by the brain and return the existing canonical owner's cancellation receipt; audio interruption alone proves neither cancellation nor reversal.

The owner transcript API accepts exactly the additional native prefix `voice-readback-<uuid>` alongside ordinary and greeting voice turns. It keeps identity conflicts, final revisions and arbitrary-prefix rejection intact.

Provider contract: https://github.com/googleapis/python-genai/blob/cb1408b06c573060f1593023ca320fde9a4fb5f6/google/genai/types.py . This supports Gemini BidiGenerateContent, not Vertex's unsupported generator fields. Live acceptance is required before closure; a test double is not microphone or provider proof.

Rollback: restore the paired standard app and Companion with their existing deployment/install owners. No runtime or business data migration.
