# R7 — versions et releases préparées, sans activation

Lecture des propriétaires existants, quatre versions avec inconnues explicites, releases plus récentes vérifiées. Contrat : docs/work/samantha-runtime/contracts/r7.md.

Validation : test HTTP R7, 14 tests tier0 et toutes les commandes CI runtime. Relecture corrigée : releases annulées exclues, rollback inconnu explicite, filtrage avant limite de 100, cache 1 s et single-flight invalidés par les sources canoniques, aucun bytecode. Base runtime `639ae68` intégrée ; toutes les routes et étapes CI conservées. CI inchangée pendant R6 #27 ; enregistrement des deux tests R7/tier0 à faire après sa fusion. Aucun état owner modifié et aucune recette S24 revendiquée. Claude relit, fusionne et recette.
