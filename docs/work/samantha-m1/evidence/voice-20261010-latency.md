# V4 — rapport reproductible des journaux fournis du 10/10

Source : ZIP `voix-logs-20261010.zip` transmis par Amine, mesure 3 uniquement. La notice de Claude indique app c5b6398 et Companion 727f555 ; Codex ne déploie pas et ne reconstitue pas les mesures 1/2 effacées. Aucun audio, transcript, texte utilisateur ou token dans ces sources selon la notice ; le rapport contient seulement des identifiants techniques, compteurs et durées.

| Source | SHA-256 |
| --- | --- |
| app.jsonl | dc7f3f12d32b103fa44e23e471395bd072a4d1003fcf1abac6f6cc6686501571 |
| companion.jsonl | bc286e2e949745799605a792512914fc394ba2ffce27ee8716522deeb8fb1449 |

Reproduction : `python3 openclaw-plugin-mobile-ui/scripts/voice-m1-analyze.py app.jsonl companion.jsonl --out docs/work/samantha-m1/evidence/voice-20261010-latency.json`. Les sources exactes fournies sont conservées localement dans `/workspace/handoff/20261010-rest/V4-current/evidence` ; aucune modification de boot_ns ou wall_ms.

Trois sid appariés, zéro exclusion pour dérive ou frontière inconnue ; les trois t99 fournis valent 0 µs.

| Intervalle | n | p50 ms | p95 descriptif ms | p95 qualifié |
| --- | ---: | ---: | ---: | --- |
| app t00 → t07c | 3 | 367,70 | 391,62 | null, n<100 |
| app t00 → Companion t01 | 3 | 356,97 | 373,83 | null, n<100 |
| Companion t01 → t07 | 3 | 9,80 | 16,22 | null, n<100 |

Le percentile descriptif ne vaut pas qualification statistique ni acoustique. Les KPI de fin réelle de parole et d’audibilité exigent toujours une référence externe ; M1 n’est pas déclaré validé par ce rapport. Les nouvelles sessions historiques nécessitent V2 #37 pour disposer de la télémétrie complète ; ce rapport reproduit des traces duplex déjà fournies.
