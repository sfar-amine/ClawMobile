# Délégation MCP : jeton du Gateway retrouvé après une mise à jour d'OpenClaw (08/11/2026)

Constat sur le S24, le 08/11 : la demande « Qu'est-ce que j'ai à l'agenda demain ? » passée par l'accès MCP
échoue en `delegation_failed`, raison `1`, alors que Google répond (lecture directe du calendrier « completed »).

Cause : `gateway-secretref-exec.sh` importait `gateway-auth-token-D8cKFnOh.mjs`. La mise à jour d'OpenClaw
2026.10.9 (S24, 31/10) a renommé ce fichier `gateway-auth-token-7OIpkk9l.mjs` : l'import échouait, l'erreur était
masquée et le script sortait en 1 sans rien dire. Toute délégation au propriétaire par l'accès MCP échouait donc
depuis le 31/10.

Correction :
- le script retrouve l'unique fichier `gateway-auth-token-*.mjs` de la version installée ;
- aucun fichier ou plusieurs : sortie 32 avec `gateway_token_resolver_unavailable` ;
- jeton vide : sortie 31 avec `gateway_token_unavailable` ; le jeton n'est jamais écrit ni passé en argument.

Test : `installer/termux-lite/test-gateway-secretref-exec.py` (version OpenClaw factice, aucun Gateway réel).
