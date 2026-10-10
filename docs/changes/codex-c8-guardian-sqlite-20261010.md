# C8 — Guardian conserve son périmètre historique main

Contrat : docs/work/samantha-runtime/contracts/c8.md. Base `bfa210cd4361f2a3273ec76032ef6d23599015fd` intégrée par merge normal et union CI. Onze tests SQLite/shell passent : capture réelle STRICT et cinq lignes main,84 main/937 lignes générées au total, absence de fenêtre temporelle, classification cron/direct et fallback200000 uniquement quand la fenêtre manque.

La réponse Claude PR77 confirme main84 et CLI9659ms, avec200000 sur toutes les fenêtres. Les fenêtres valides présentes272000/128000 de la capture brute restent conservées : leur résolution effective doit être prouvée par la fixture CLI ligne à ligne et la règle installée. Gate bloqué, pas de preuve3/3 inventée, pas de déploiement ni de mesure Guardian après sur le S24.
