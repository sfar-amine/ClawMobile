# Pulse room: messages with several requests — 26 October 2026

On 26/10 at 15:37:50Z, Sadok sent two requests in one WhatsApp message:

1. État su projet zain phase 5
2. Passe la phase réalisation du projet 20495 a non débuté

The room passed the whole message as one request, and it was refused. Amine: « il faut gérer ce genre de demande automatiquement ».

- `dialogueSurface.ts`: `splitRequests` splits only a message that is an enumeration from its first line (`1.`, `2)`, `-`, `•`…), with 2 to 10 items. A line without a marker continues the previous item. Anything else stays one request (for example « nom projet …\nclient … »).
- `pulseRoomFastPath.ts`: the requests run one after the other, each as its own event (`<messageId>#1`, `#2`). In the native room, each one gets its own admission and hand-off. The reply numbers the answers.
- If a request asks a question, the run stops. The coordinator (playbooks change of the same name) keeps the remaining requests, and the contact is told so. The answer turn hands them back (`resumeRequests`), and they then run as `<messageId>#r1`…
- No local state: no Map, no timer, no retry.

Tests: `test-pulse-room-fast-path.cjs` with Sadok's real message. Rollback: revert this commit.
