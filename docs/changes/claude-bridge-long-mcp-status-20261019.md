# Pont distant : test long renforcé par le relais MCP (reprise WIP Codex)

Repris de la branche WIP `codex/wip-bridge-long-20261018-e0a0f7d5` (e0a0f7d5, non qualifiée). Le test `test-bridge-long.cjs` passe désormais par le vrai point d'entrée `mcpBridge.handleMcpRelayRequest` (outil `claw_exec`, profil `chat-owner`) au lieu d'appeler le pont directement. Il vérifie aussi :

- la réponse `running` d'une commande longue dans le budget public de 15 s ;
- `retry_allowed:false` ;
- la relecture de la fin par `claw_status` (`completed`, sortie conservée) ;
- l'absence du `stderr` privé dans le reçu public ;
- l'absence de second lancement.

Test seul : aucun code runtime modifié. Retour arrière : revert.
