# Garde MCP du socle L2 alignée sur 8000 jetons — 28 octobre 2026

Après l'activation des playbooks #330, qui relèvent le plafond du socle à 8000 jetons, et la réactivation de L2 le 28/10 à 10h12, `claw_context` échouait encore, cette fois avec `foundation_mcp_response_budget_exceeded`. Le producteur sert 6171 jetons (environ 24,7 ko), mais le Companion refusait toujours au-delà de 24000 octets.

Les deux gardes du Companion suivent maintenant le même plafond de 8000 jetons, soit 32000 octets UTF-8 : la réponse MCP de `claw_context` (`mcpBridge.ts`) et le texte du socle injecté dans les tours du Gateway (`ownerBootstrapContext.ts`). Rien n'est tronqué ; un socle plus gros reste refusé.

Test : `test-mcp-foundation.cjs` livre un socle de 24700 octets et refuse 32001 octets. Retour arrière : revert, ou `SAMANTHA_CONTEXT_FOUNDATION=0`.
