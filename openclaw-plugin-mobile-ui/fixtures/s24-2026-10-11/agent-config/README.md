# Capture de charge avant correction

Source : PR sfar-amine/samantha-core#170, commit `a75955f8bc21f84984a1df9c10f1afaf2d8ad87a`, capture S24 nettoyée du 11 octobre 2026. Fichier repris sans modification. SHA-256 : `a3b1922c549bfefde361e16fc8a5e3d8d27cbaa06434e12b50a360d9a35c10ac`.

Mesures avant #167 uniquement : 12/12 requêtes concurrentes en 503 ; durée 16,188–16,310 s. Aucun résultat après correction revendiqué. Les compteurs Gateway sont des fenêtres partagées, sans attribution certaine à la route.

## Complément indépendant PR173 (avant correction)

Source : https://github.com/sfar-amine/samantha-core/pull/173, commit `3bd2e7423e31fce2e62f7ebead0bf036b433c87b`, chemin original `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/lot-r/agent-config-budget.json`. Copie byte-identique `agent-config-budget-pr173-before.json`, SHA-256 `adbf90841c76203ebc44ffbd4a1af6d33aa4b4d2b2dbfcec2b3d456da02819d3`. Runtime déployé `3298d98d8a29458abda6617c37ca5e4b114f4be2`, #167 non déployée.

Sur cette passe : 18/18 réponses dépassent 9 s, 2 réponses 200 à 9,195/9,827 s et 16 réponses 503 ; 12 lecteurs concurrents tous 503. `models.authStatus` seul 9,809 s en CLI, charge 13,08. Ces mesures complètent PR170 sans la remplacer et ne prouvent aucun gain du correctif. Capture après déploiement par Claude toujours requise.
