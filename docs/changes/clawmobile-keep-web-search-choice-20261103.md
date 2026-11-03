# Garder le fournisseur de recherche web choisi (3 novembre 2026)

## Problème

`clawmobile configure_lite_defaults` vidait toujours `tools.web.search.provider` et
désactivait le plugin Codex. Le 03/11, Amine a choisi Codex Hosted Search pour la
recherche web : Sol reste sur le runtime OpenClaw et seul `web_search` passe par Codex,
avec son compte OpenAI, sans clé. Avant, le repli automatique tombait sur Gemini
gratuit (filtres refusés puis quota 429). Un prochain `clawmobile setup` ou
`configure defaults` aurait effacé ce choix.

## Changement

Si un fournisseur est déjà fixé, la fonction le garde avec son plugin. Sinon, le défaut
Android est inchangé (fournisseur vide, plugin Codex désactivé). Test sur la fonction
réelle, inscrit dans la CI ; capture S24 du changement et du test de recherche.

## Retour arrière

Revert de la PR. Sur le S24 : `openclaw config unset tools.web.search.provider` puis
`openclaw plugins disable codex` (sauvegarde `~/.openclaw/backups/codex-search-20261103`).
