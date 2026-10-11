# Lectures concurrentes de /agent/config

La route garde ses lectures fraîches de configuration, modèle et admission. Les lecteurs simultanés partagent désormais aussi les deux lectures informatives déjà existantes : `sessions.list` et `sessions.usage`. Douze requêtes froides ne multiplient plus ces deux appels par douze. Leurs TTL, budgets, erreurs et la validation CAS des mutations sont conservés.

La source est confirmée par les captures S24 nettoyées `s24-2026-10-10/ui-recette` et `p0-3/sessions.usage.json`. Les mesures historiques de recette donnent 4 790 et 3 739 ms pour la route ; elles ne sont pas une mesure du correctif. La recette du 11/10 signale environ 85 % du budget : capture fraîche demandée à Claude pour séparer temps de chaque méthode et contention.

Le test couvre les captures réelles avec ordonnancement et erreurs synthétiques. Aucun test ni suite entière n'est encore revendiqué. Route existante, budget inchangé de 9 s ; aucune nouvelle opération agent ni capability ajoutée. Le contrat owner R6 reste applicable. Retour arrière : revert, par Claude.
