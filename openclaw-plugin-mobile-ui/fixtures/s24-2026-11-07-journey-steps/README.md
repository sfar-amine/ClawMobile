# S24 07/11/2026 — étapes du parcours (outils typés, réflexion)

Capture en lecture seule sur le S24 (OpenClaw 2026.10.9, modèle `gpt-5.6-sol`) :

- `turns.json` › `turns` : deux tours owner réels de l'agent `main`, lus dans `transcript_events` de
  `~/.openclaw/agents/main/agent/openclaw-agent.sqlite`. Gardés : type d'événement, horodatage, nom d'outil,
  `action`, identifiant d'appel, `isError` du résultat, `stopReason` et les titres du résumé de réflexion du modèle
  (suites de 6 chiffres ou plus masquées). Aucun texte d'Amine, aucun argument hors `action`, aucun résultat d'outil.
  - `orange-balances` : `samantha_maxit_tunisie` / `telecom.orange.balances` (le résultat est stocké compressé ;
    seule sa date de ligne est gardée).
  - `agenda-read-create-cancel` : `samantha_agenda` lecture, création puis `cancel`.
- `turns.json` › `engineContract` : extraits et SHA-256 des modules installés qui fixent la forme des événements
  Gateway reçus par le Companion : début d'outil `{phase, name, toolCallId, args}`, flux `thinking` `{text, delta}`
  et sa diffusion aux abonnés de session.

Utilisée par `scripts/test-run-journey-steps.cjs`.
