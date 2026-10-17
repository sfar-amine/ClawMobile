# S24 captures — SAM-MIG-CC-001 V2.2, lot L3 (16/10/2026)

Read-only captures (`claw_exec`, `action_key sammig-v22-L3-coord-20261016`), cleaned before commit:

- `runs-clarification-inventory.json` (step `runs-clarif`): projection fields of the 33 runs of
  `~/.openclaw/clawmobile-companion/runs.json`. Run and session ids are hashed (sha256, 12 chars); no text,
  decision or result. Fact used by the cutover plan (B-07/B-10): 3 clarifications, all `resolved`, 0 `pending`.

Other facts confirmed in the same session (not stored as files):

| Step | Fact |
|---|---|
| `bd-payload`, `bd-payload2` | `before_dispatch` event: `messageId`, `content`, `body`, `channel`, `sessionKey`, `senderId`, `isGroup`, `timestamp` (OpenClaw 2026.9.6, `dispatch-from-config` l. 910-923) |
| `store-loc` | `~/.openclaw/samantha-dialogue/` is absent (free). The synchronized roots are `context-sync` and `workspace/ui-playbooks`. No maintenance marker exists. Python SQLite is 3.53.4. |
| `ingress-shape` | `channel_ingress_events` columns; `received_at` is in milliseconds; 3 latest WhatsApp rows are `completed` with `attempts=0` |
