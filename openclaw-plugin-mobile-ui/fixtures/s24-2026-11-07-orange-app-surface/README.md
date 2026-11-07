# S24 07/11/2026 — Orange refusé sur un tour écrit de l'app

Capture en lecture seule sur le S24 (Companion 1bf6ca93) :

- `runStatus` : `GET /v1/runs/run_1794064014193_f0987f1c` tel que servi par le Companion déployé (« mon solde orange »
  partagé depuis l'app à 16:06). Pas de champ d'origine du tour.
- `routeHealth` : dernier échec des deux routes Orange dans `~/.openclaw/skill-intelligence/route-health.json`. À 15:17,
  `network_snapshot_unavailable` ; à 16:07, `orange_cellular_required_wifi_kept` (Wi-Fi gardé comme pour une voix en direct).
- `playbooksRuntime` : SHA-256 des fichiers installés qui fixent la restriction (`maxit_guarded_service.py`,
  `capability_graph.py`, `execution_graph.json`) ; `executionGraphSurfaces` : types `claw_live` = voice, `samantha_android` = app.

Aucun numéro, solde ni secret. Utilisée par `scripts/test-typed-app-surface.cjs`.
