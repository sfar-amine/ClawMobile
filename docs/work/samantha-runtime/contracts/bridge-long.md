# Bridge long — commandes MCP plus longues que l'attente de l'edge (fichier 41, piste 3)

## Comportement réel (S24, 11/10, 01:35 UTC)

Chemin : client MCP → Worker Cloudflare `cloud/voice-relay` (Durable Object `VoiceRelay`, `src/mcp.mjs` puis `src/index.mjs`) → WebSocket → Companion `voiceRelay.ts` → `mcpBridge.ts` → reçu canonique `remoteBridge.ts` (`~/.openclaw/remote-bridge/requests/<requestId>.json`).

- `VoiceRelay.waitForResponse` attend la réponse de l'appareil **28 s** puis répond `{success:false, error:"device_timeout"}`. Le Companion n'a pas d'échéance de son côté : `exec_wait` tourne jusqu'à son `timeout_ms` (30 s par défaut, 300 s max) et le reçu passe à `completed`.
- `handleMcpTool` **mettait en cache** cette erreur (`recent`, 10 min) sous le `requestId` stable `mcp-<client>-<action_key>-<step_key>`. Un nouvel appel avec les mêmes clés renvoyait donc `device_timeout` immédiatement, même après la fin de la commande, sans atteindre l'appareil.
- `claw_status` (requestId aléatoire, jamais en cache) lisait correctement `running` puis `completed`.
- Inventaire au même instant : 70 `exec_wait` externes de plus de 25 s, dont 69 `completed` et 1 `indeterminate` (redémarrage du Companion) ; durée médiane 33,8 s, max 285,8 s. Fixture : `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11c/bridge-long/observation.json`.

## Correctif (propriétaire existant : `cloud/voice-relay`)

Pour `claw_exec` et `claw_execute` seulement (reçu idempotent par `action_key`/`step_key`) :
- fin d'attente edge (`device_timeout`) → `{state:"running", request_id, retry_allowed:false, transport:"device_timeout", status:{tool:"claw_status", action_key, step_key}}` ;
- liaison coupée après l'envoi (`device_disconnected`) → même forme avec `state:"indeterminate"` (effet inconnu) ;
- `device_timeout`, `device_disconnected` et `device_send_failed` ne sont **plus mis en cache** : un appel suivant avec les mêmes clés atteint l'appareil, dont `submitRemoteBridgeRequest` renvoie le reçu existant (`running`, `completed` ou `indeterminate` après redémarrage) **sans second dispatch** ;
- un résultat de l'appareil reste mis en cache comme avant.

Outils de lecture (`claw_context`, `claw_resolve`, `claw_status`, `claw_artifact_read`) et chemin voix `/voice` : inchangés. Aucun nouveau service, store, file ou timer ; l'attente reste 28 s (sous le budget client ~30 s).

## Tests et recette

- `cloud/voice-relay/test-long-action.mjs` (CI, étape « MCP context scopes… ») : running sans erreur, pas de cache, même requestId renvoyé à l'appareil, résultat terminal mis en cache, coupure → indeterminate, lecture et voix inchangées.
- Recette (Claude, après publication du Worker) : `claw_exec` `sleep 35` avec un `action_key` neuf → `state:"running"` ; `claw_status` → `running` puis `completed` ; second `claw_exec` mêmes clés après la fin → reçu `completed` ; un seul `exec_wait` dans `requests/`.

## Retour arrière

Revert de la PR puis republication du Worker selon la procédure existante. Aucun état durable.
