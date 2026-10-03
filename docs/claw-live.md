# Claw Live v2

claw-live is the Termux live observability view for Claw on the S24.
It aggregates existing runtime sources into a semantic stream without changing Memory Core
or adding a daemon or scheduler.

## Default view

Run: claw-live

The default detailed view shows:
- [CHAT] ChatGPT text surface activity.
- [VOICE] ChatGPT Voice state and recovery activity.
- [WHATSAPP] inbound/outbound message previews and model turns.
- [IMMUNE] health, incident, diagnosis, recovery and human-required transitions.
- [IMPROVE] autonomous repair, Dreaming and Skill Intelligence improvement stages.
- [TERMUX] detailed commands and tools issued by ChatGPT or OpenClaw.
- [JOB] and [CRON] OpenClaw background model-backed sessions.
- [SYNC] autonomous engineering delivery and publication receipts.
- [MEMORY] new canonical Memory Core durable events.
- [BRIDGE] Remote Desktop Commander lifecycle and recovery events.

Colors are semantic: stream tags keep stable colors, while action and result colors encode
success, recovery, warning, command/model activity, or failure. A single line may use
multiple colors to preserve both source and state meaning.

## Message and command detail

WhatsApp previews are enabled by default and bounded to 160 characters.
OpenClaw transcript thinking blocks are intentionally ignored. The view shows user-visible
message text, model/provider identity, tool calls, command arguments, tool results and delivery state.

Termux commands are shown in detail for both execution planes:
- ChatGPT -> Remote Desktop Commander -> S24.
- OpenClaw agent/job/cron/WhatsApp model sessions -> OpenClaw tools -> S24.

Fields matching credentials, authorization, tokens, passwords, cookies, OTP/security-code
patterns and payment-card-like long numbers are redacted. File write/edit bodies are omitted.

## Chat and Voice labeling

The surface observer uses Android state to distinguish ChatGPT text from Voice.
Voice activity is grounded on RECORD_AUDIO runtime state.

When ChatGPT is foregrounded, claw-live performs a bounded UI inspection once on the
foreground transition and caches the visible conversation title when a reliable candidate is found.
Conversation IDs visible in ChatGPT deep links are also cached.

If a Voice title is unavailable, the renderer uses session HH:MM.
If a Chat title is unavailable, it uses ChatGPT until a title is observed; it never invents one.

The bounded registry is stored at ~/.openclaw/observability/surfaces.json.

## Sources

Primary runtime sources:
- ~/.openclaw/watchdogs/remote-desktop-process.log
- ~/.openclaw/agents/main/agent/openclaw-agent.sqlite
- ~/.openclaw/people/directory.db
- ~/.openclaw/health/health.log
- ~/.openclaw/incidents/events.log
- ~/.openclaw/incidents/orchestrator-worker.log
- ~/.openclaw/watchdogs/remote-desktop.log
- ~/.openclaw/watchdogs/adb-recovery.log
- ~/.openclaw/autonomous-engineering/shadow/*.json
- ~/.openclaw/autonomous-engineering/deliveries/*.json
- ~/.openclaw/skill-intelligence/improvements.db
- ~/.openclaw/workspace/memory/dreaming/
- ~/.openclaw/context-sync/memory.db

The default view starts at the live tail/current SQLite rowid. It does not replay old transcripts.

## Background resilience

The semantic/default mode follows its log sources inside the claw-live Python process. It must not
spawn one persistent `tail -F` child per source: on Android those native Termux children are tracked
as phantom processes and consume the platform child-process budget while Termux is backgrounded.
Keeping file followers in-process reduces that pressure without disabling Android process protections.

Raw mode remains a break-glass diagnostic mode and may use external `tail` processes while it is
actively observed.

## Modes

claw-live
claw-live --compact
claw-live --raw
claw-live --only immune
claw-live --only improve
claw-live --only whatsapp
claw-live --only chat
claw-live --only voice
claw-live --only termux
claw-live --history 80 --only agent
claw-live --no-color

Raw mode is the break-glass diagnostic path and tails the underlying Desktop Commander and
OpenClaw logs without semantic normalization.

## Installation

From the ClawMobile checkout run installer/termux-lite/install-claw-live.sh.

Installation compiles the candidate first, backs up a different existing runtime version,
then atomically replaces ~/bin/claw-live and refreshes $PREFIX/bin/claw-live.

## Validation

Targeted tests: cd installer/termux-lite && python3 test-claw-live.py

Acceptance requires syntax and test pass plus a live Termux run showing at least:
1. a [TERMUX][CHAT] Desktop Commander command,
2. an [IMMUNE] or [BRIDGE] runtime event,
3. a real OpenClaw SQLite event when one occurs,
4. no raw secret payloads in the rendered output.
