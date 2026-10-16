# Lectures concurrentes de /agent/config

La route garde ses lectures fraîches de configuration, modèle et admission. Les lecteurs simultanés partagent désormais aussi les deux lectures informatives déjà existantes : `sessions.list` et `sessions.usage`. Douze requêtes froides ne multiplient plus ces deux appels par douze. Leurs TTL, budgets, erreurs et la validation CAS des mutations sont conservés.

La source est confirmée par les captures S24 nettoyées `s24-2026-10-10/ui-recette` et `p0-3/sessions.usage.json`. Les mesures historiques de recette donnent 4 790 et 3 739 ms pour la route ; elles ne sont pas une mesure du correctif. La recette du 11/10 signale environ 85 % du budget : capture fraîche demandée à Claude pour séparer temps de chaque méthode et contention.

Le test couvre les captures réelles avec ordonnancement et erreurs synthétiques. Aucun test ni suite entière n'est encore revendiqué. Route existante, budget inchangé de 9 s ; aucune nouvelle opération agent ni capability ajoutée. Le contrat owner R6 reste applicable. Retour arrière : revert, par Claude.

Capture réelle avant correction : core #170, commit `a75955f8`, reprise exacte dans `fixtures/s24-2026-10-11/agent-config/`. Froid 7473 ms ; chaud jusqu’à 9569 ms ; 12/12 requêtes concurrentes en 503 après 16188–16310 ms. Les journaux ne distinguent pas les appelants. Le test utilise cette capture pour fixer charge et budget, et les réponses nettoyées du 10/10 pour la projection. La diminution des appels est vérifiable localement ; budget et débit après correction restent à mesurer sur S24, sans annoncer de résultat déjà atteint.

Vérification ciblée locale : installation Node20, build TypeScript, test de coalescence douze lecteurs/échec/récupération et contrat agent/config tous verts sur source `61692019`. Aucun échec local masqué. La dernière suite CI entière reste à exécuter au SHA final avant publication prête.

Complément réel PR173 (`3bd2e7423e31fce2e62f7ebead0bf036b433c87b`) repris byte-identique avec provenance et empreinte dans le README fixture : 18/18 appels au-dessus de 9 s, dont 12 concurrents tous 503, au runtime 3298d98d avant #167. Cette passe et celle de PR170 ont des conditions distinctes ; aucune valeur ne constitue une mesure après correction. Claude doit déployer puis refaire froid/chaud/12 lecteurs avec timings et fraîcheur du reçu.


Reprise fichier 46 : ciblés rejoués sur la base runtime `7c5cddc5`, douze lecteurs et récupération après erreur verts. Le correctif propriétaire F6 `dc5cc696` est repris : au-delà de 4096 entrées /proc, la preuve de vie reste inconnue ; aucun abandon fondé sur une liste tronquée. Le ciblé conserve 50020 reçus, 17 abandons et un budget de 10 s (435 ms observés). Les mesures S24 après correction restent à Claude.

## Complément R02 — fichier 52

La projection publique complète de `/agent/config` est maintenant servie pendant 5 s et partagée entre lecteurs concurrents. Une projection incomplète n'est pas mise en cache et une mutation prouvée invalide immédiatement la projection. Le déploiement compare les temps à la dernière recette `deployed` : un dépassement n'est bloquant que s'il dépasse aussi la release précédente de 50 % et d'au moins 0,5 s. Sans reçu antérieur, les budgets fixes restent la référence.

La recette préchauffe `/catalog` avant sa ligne mesurée. Le préflight écrit un reçu `deferred` lorsque RAM disponible < 1 200 Mo et batterie en décharge, avant fetch, build ou redémarrage. Les tests injectent les latences Gateway 2 s et 10 s, la variance 9,0 → 9,5 s, le préchauffage, douze lecteurs et la récupération après erreur. Les opérations téléphone, S24, paiement et déploiement restent hors de cette PR.
