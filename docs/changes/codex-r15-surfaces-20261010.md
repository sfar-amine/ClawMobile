# R15 — surfaces connectées

Vue agrégée en lecture seule depuis les reçus Remote Bridge existants et les transports R9. Métadonnée authentifiée ajoutée aux futurs reçus MCP, aucun registre ni révocation.

Build, test-security-surfaces et toutes les étapes CI locales passés. Compatibilité et recette S24 par Claude ; aucun déploiement Codex.

Base runtime 639ae68 intégrée par merge ; R2 et R12 inclus, étapes CI conservées. Le test MCP existant passe avec une fixture Python locale de contexte sans required_reads pour les fichiers de contexte absents du Cloud, sans qualifier le contexte S24. Les étapes existantes restent conservées.

Revue26 : base 0bf30ab (R14 fusionné) intégrée, toutes routes et étapes CI conservées. Provenance MCP interne non sérialisable, métadonnée JSON HTTP ignorée. Classement mtime sur le répertoire complet ; date nulle si scan incomplet. Fixture50k, test R15 dans CI, acceptance GET1,5s et POST405. Aucun effet S24.
