# Captures S24 — recette UI n°2 du 10/10/2026

Capturées par Claude le 10/10/2026 entre 20:47 et 20:51 UTC sur le S24 (Termux), en lecture seule, avec le Companion `f95be8d` déployé (OpenClaw `2026.9.6`) et l'app `3694022` installée. Moyens : MCP Claw `claw_exec`, `curl -H 'Connection: close' http://127.0.0.1:8765/v1…` (mêmes en-têtes que l'app, sans jeton), et `openclaw gateway call <méthode> --json` lancé seul. Aucune écriture, aucun redémarrage.

## Fichiers
- `companion.providers.json` : `/v1/providers` à froid (5,6 s), juste après l'échec de `usage.status`. Copilot y est `ready` au lieu de `exhausted`.
- `companion.usage-cost.json` : `/v1/usage?details=cost` avec `cost.totals.totalCost` et `daily[].totalCost`, la forme que l'app ne lisait pas.
- `companion.agent-config.json` : `/v1/agent/config` (6,1 s). Défaut capturé : `issues:["session_thinking_defaults_unavailable"]`, gpt-5.6-sol réduit à `["off"]` avec `thinkingSource:"unavailable"`.
- `companion.metadata-decision.json` : métadonnées de `decision-v2-live-5a66bfd3a1`. Même réponse avec et sans `x-clawmobile-owner-flow`.
- `companion.metadata-degraded.json` : métadonnées de la conversation « Mon solde Orange » : `state:"degraded"`, `readOnly:true`.
- `gateway.usage.status.json` : `usage.status` lancé seul (3,5 s). Les fenêtres Copilot n'ont pas de `resetAt`.
- `gateway.sessions.list.limit1.json` : `sessions.list {limit:1}` lancé seul (2,2 s), `defaults` avec 8 niveaux pour gpt-5.6-sol.
- `measures.json` : latences mesurées et constats.

## Nettoyage
- Montants (`*Cost`, `costUsd`) : valeurs fictives. Le total 30 jours vaut 1,25.
- Poignées de compte : `acct-0000000000a1` et `acct-0000000000a2`.
- Révision : `hmac-sha256:v1:QQQ…`.
- Session privée : `samantha-00000000-0000-4000-8000-00000000000a`.
- Champs de compte de `usage.status` (`accountEmail`) : supprimés.
- `daily` : 30 lignes, dont 5 gardent leurs vrais compteurs de tokens.
- Vérification finale : aucune adresse e-mail, aucun numéro `+216`.
