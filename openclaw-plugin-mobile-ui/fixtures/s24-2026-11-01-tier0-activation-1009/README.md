# S24 01/11/2026 : activation tier0 manquée après la bascule OpenClaw 2026.10.9

Relevé en lecture seule sur le S24 de prod, le 01/11 entre 21:40 et 21:50 UTC. Le home est noté `~`. Aucun secret ni texte utilisateur n'y figure.

`capture.json` contient :
- le reçu du déploiement `3543780d` (`rollback_failed`, `runtime_sync_failed`). Son redémarrage de Gateway a réussi : une cible, adoptée.
- les lignes du root-guardian pendant les deux promotions : celle du déploiement, puis celle de son retour arrière.
  - Dans les deux cas, la porte IA refuse la relance de l'orchestrateur d'incidents (`ai_gate_refused`).
  - L'orchestrateur ne démarre qu'après la fenêtre de 120 s. Pour la seconde promotion, il démarre 12 s après la fin de la fenêtre (époques exactes). Pour la première, l'heure exacte de début d'activation est perdue : seule une borne basse de l'échéance est connue, et la promotion a échoué.
- l'état tier0 obtenu : la release qui venait d'échouer son activation est devenue `last_known_good`.
- la release `last_known_good` confirmée avant ce soir.

Tests qui rejouent ce relevé : `installer/termux-lite/test-root-guardian-gate.py` et `installer/termux-lite/test-tier0-activation-readiness.py`.
