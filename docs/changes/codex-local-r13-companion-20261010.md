# R13 — détail natif d’une capacité (companion)

La fiche de l’écran 27 lit uniquement le registre canonique du snapshot runtime choisi par Control. Identité exacte, métadonnées expurgées, aucune exécution ni santé live inventée.

Validation : Build and dedicated HTTP fixture plus actual canonical-registry pairing passed; all existing ci.yml contract commands passed ; dedicated R13 tests were also run manually.

Deux PR appariées : Claude fusionne playbooks, épingle le snapshot, puis fusionne Companion et fait la recette. Aucun déploiement ni merge Codex. Retour arrière : revert de la PR R13.

CI : ci.yml reste identique à la base, son édition étant réservée à une autre PR. Le test R13 dédié est exécuté séparément ; son ajout automatique attend la coordination CI.
