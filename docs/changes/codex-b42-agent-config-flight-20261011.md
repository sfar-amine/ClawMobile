# Lectures concurrentes de /agent/config

La route garde ses lectures fraîches de configuration, modèle et admission. Les lecteurs simultanés partagent désormais aussi les deux lectures informatives déjà existantes : `sessions.list` et `sessions.usage`. Douze requêtes froides ne multiplient plus ces deux appels par douze. Leurs TTL, budgets, erreurs et la validation CAS des mutations sont conservés.

La source est confirmée par les captures S24 nettoyées `s24-2026-10-10/ui-recette` et `p0-3/sessions.usage.json`. Les mesures historiques de recette donnent 4 790 et 3 739 ms pour la route ; elles ne sont pas une mesure du correctif. La recette du 11/10 signale environ 85 % du budget : capture fraîche demandée à Claude pour séparer temps de chaque méthode et contention.

Le test couvre les captures réelles avec ordonnancement et erreurs synthétiques. Aucun test ni suite entière n'est encore revendiqué. Route existante, budget inchangé de 9 s ; aucune nouvelle opération agent ni capability ajoutée. Le contrat owner R6 reste applicable. Retour arrière : revert, par Claude.

Capture réelle avant correction : core #170, commit `a75955f8`, reprise exacte dans `fixtures/s24-2026-10-11/agent-config/`. Froid 7473 ms ; chaud jusqu’à 9569 ms ; 12/12 requêtes concurrentes en 503 après 16188–16310 ms. Les journaux ne distinguent pas les appelants. Le test utilise cette capture pour fixer charge et budget, et les réponses nettoyées du 10/10 pour la projection. La diminution des appels est vérifiable localement ; budget et débit après correction restent à mesurer sur S24, sans annoncer de résultat déjà atteint.

Vérification ciblée locale : installation Node20, build TypeScript, test de coalescence douze lecteurs/échec/récupération et contrat agent/config tous verts sur source `61692019`. Aucun échec local masqué. La dernière suite CI entière reste à exécuter au SHA final avant publication prête.

Complément réel PR173 (`3bd2e7423e31fce2e62f7ebead0bf036b433c87b`) repris byte-identique avec provenance et empreinte dans le README fixture : 18/18 appels au-dessus de9s, dont12 concurrents tous503, au runtime3298d98d avant#167. Cette passe et celle dePR170 ont des conditions distinctes ; aucune valeur ne constitue une mesure après correction. Claude doit déployer puis refaire froid/chaud/12 lecteurs avec timings et fraîcheur du reçu.
