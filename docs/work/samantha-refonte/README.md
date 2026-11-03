# Refonte parcours unique

[Spécification complète](SPEC-refonte-parcours-unique-20261025.md), importée sans modification du commit5f26dac0 de `claude/refonte-spec-20261025`.

[Triage des anciennes PR](TRIAGE-chantier1-20261025.md).

Livraison : L0 en cours, puis L1, L2, L3, L4, L5. L6 peut avancer indépendamment. Chaque clôture exige trace, mesure et reçu réels S24. Aucune clôture de lot revendiquée par cette intégration documentaire.

Préparation L3 : [décision d’architecture du cerveau et des outils typés](../../08-decisions/ADR-20261025-brain-only-typed-tools.md). Interrupteur éteint tant que L1/L2 et la recette appariée ne sont pas verts ; le code legacy reste uniquement pour cette bascule et son retour arrière temporaire.

[Audit natif L3 : continuité steer et schémas Gemini](L3-native-steer-google-audit-20261026.md). Sources installées hashées et tests capturés ; recette de consommation de Stop et rattachement des ingress adoptés à qualifier avant clôture.
