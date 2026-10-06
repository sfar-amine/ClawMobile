# Claw Live v2

claw-live is the Termux live observability view for Claw on the S24.
It aggregates existing runtime sources into a semantic stream without changing Memory Core
or adding a daemon or scheduler.

## Default view

Run: claw-live

The default detailed view uses a consistent four-part vocabulary:

1. **Surface / actor** — who initiated or owns the interaction: `[GPT-CHAT]` for ChatGPT text, `[CLAUDE-CHAT]` for Claude text via MCP, plus `[VOICE]`, `[WHATSAPP]`, `[AGENT]`, `[JOB]`, `[CRON]`.
2. **Transport / execution path** — how it reached Claw: `[MCP]`, `[RDC]`, `[SLACK]`, `[ADB]`, `[LOCAL]`, `[OPENCLAW]`, `[TERMUX]`.
3. **Access scope when relevant** — `[OWNER]` or `[SHADOW]` for authenticated MCP execution. These are authorization labels, not health states.
4. **Action / state** — `START`, `CMD`, `TOOL`, `MODEL`, `DONE`, `FAILED`, `WARN`, `DELEGATED`, etc.

Examples:

```text
09:42:10 [CLAUDE-CHAT][MCP][OWNER] [wifi-check] DONE device.assistance → OWNER
09:42:14 [CLAUDE-CHAT][MCP][OWNER][OPENCLAW] [daily-recap] DONE memory.cross_surface · via openclaw.agent.main → DELEGATED
09:42:18 [CLAUDE-CHAT][MCP][SHADOW] [old-check] DONE memory.cross_surface → READ_ONLY
09:42:22 [GPT-CHAT][RDC][TERMUX] [Claw] CMD $ python3 ...
09:42:30 [WHATSAPP] [Contact] IN "message preview"
```

This distinction is intentional: an MCP receipt must never be labeled `[SLACK]` merely because both transports share the Remote Bridge receipt directory.

Other semantic domains remain:
- `[IMMUNE]` health, incident, diagnosis, recovery and human-required transitions;
- `[IMPROVE]` autonomous repair, Dreaming and Skill Intelligence improvement stages;
- `[SYNC]` engineering delivery/publication receipts;
- `[MEMORY]` canonical Memory Core durable events;
- `[BRIDGE]` generic bridge lifecycle/recovery events when no more specific transport applies.

Colors are semantic: stream tags keep stable colors, while action and result colors encode
success, recovery, warning, command/model activity, or failure. A single line may use
multiple tags only when each tag answers a different question (actor, path, access or engine).

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
claw-live --only gpt-chat
claw-live --only chat        # alias compatible de gpt-chat
claw-live --only claude-chat
claw-live --only claude      # alias compatible de claude-chat
claw-live --only voice
claw-live --only termux
claw-live --only mcp
claw-live --only owner
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

### Android phantom-process headroom — S24

On the validated S24 runtime, Android ActivityManager's default effective
max_phantom_processes=32 was proven to trim a background Termux shell and its
claw-live child. The semantic in-process log followers reduce the process
footprint, but concurrent Claw workflows can still approach the platform limit.

The S24 runtime therefore uses the bounded DeviceConfig value
activity_manager/max_phantom_processes=128. This raises headroom without
disabling Android's phantom-process monitor. The exact pre-state was an absent
DeviceConfig override with effective default 32. Rollback is deletion of the
DeviceConfig override, restoring the OEM default.

Acceptance on 2026-10-03 used 50 temporary sleeping children (78 Termux
processes total), moved Termux to background, and verified that the same
claw-live PID survived with no new Trimming phantom processes event.
