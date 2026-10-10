# A10 — entrée logcat et exclusion des horloges dérivées

Correction limitée à l’analyseur et ses tests. La sonde d’horloge A8 est reprise par Claude avec l’accord de ChatGPT ; aucun changement d’horloge, de Warm, d’Android ou de runtime dans ce commit.

L’analyseur ignore les bannières logcat et les lignes textuelles hors JSON. Les lignes commençant par un objet/tableau JSON restent contrôlées : JSON mal formé, schéma invalide et annotation clock_drift_us non numérique produisent un diagnostic avec fichier et ligne. Les données de télémétrie invalides ne sont pas silencieusement acceptées.

Une annotation de fermeture x.clock_drift_us d’amplitude >= 1000 µs exclut tous les tours de ce sid ; la liste clock_drift_excluded_sessions rend l’exclusion visible. Le seuil inclut 1000 pour couvrir une dérive > 1 ms tronquée en microsecondes entières par le producteur. Les événements originaux et leurs timestamps ne sont pas corrigés a posteriori ; aucune substitution wall clock.

Contrat C1 relu à 32dc132e07af61e736c85bfc487fe9355056c1aa : setup t00–t07c au tour 0 ; numérotation par ordre d’envoi de turnStart/input_start. Tests supplémentaires pour setup, bannières, JSON mal formé, dérives signées et métadonnées invalides.

Validation : python3 openclaw-plugin-mobile-ui/scripts/test-voice-m1-corpus.py, 10/10 ; campagne CLI positive avec bannière et négative avec JSON mal formé ; git diff --check. La CI de la PR #1 exécute déjà ce test.

État S24 communiqué par Amine : acquittement 0.4 enregistré (c842ab78), relecture PR #1 (cb81098d). Ces reçus sont des références fournies par Amine ; aucune écriture S24 ni consultation runtime depuis cette session. Le coût bloquant de l’ancienne sonde (134 ms p50 / 156 ms max mesurés sur S24, selon la relecture) doit être levé par la correction de Claude avant déploiement. Déploiement labo sur décision d’Amine, puis recette intégrée app + Companion par Claude. Aucun gate M1 validé ici.

Rollback : revert du seul commit de correction A10. Corpus de stimuli conservé sans modification.
