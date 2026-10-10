# R15 — surfaces connectées

Vue agrégée en lecture seule depuis les reçus Remote Bridge existants et les transports R9. Métadonnée authentifiée ajoutée aux futurs reçus MCP, aucun registre ni révocation.

Build, test-security-surfaces et toutes les étapes CI locales passés. Compatibilité et recette S24 par Claude ; aucun déploiement Codex.

Base runtime 639ae68 intégrée par merge ; R2 et R12 inclus, étapes CI conservées. Le test MCP existant passe avec une fixture Markdown locale pour les fichiers de contexte absents du Cloud, sans qualifier le contexte S24. ci.yml reste inchangé pendant la correction R6 #27.
