# R5-bis — Révision SQLite de la configuration des automatisations

Référence : issue core59 et fichiers29 et33 (source attestée par Claude sur S24). Base Core2c2c18f intégrée par merge normal, propriétaire playbookscd8be74. Les captures nettoyées du schéma/quelques lignes restent manquantes ; la préparation est bloquée et la demande sera portée dans la PR via @claude conformément au fichier33. Publication uniquement après le signal d’ordre du parent, sans qualification S24.

## Propriétaire unique

Le propriétaire Python reporting existant fournit `python3 -m reporting.control_snapshot --automation-revision`. La lecture cible uniquement `~/.openclaw/state/openclaw.sqlite` ou l'OPENCLAW_STATE_DIR canonique, table cron_jobs, en mode=ro et query_only. Aucun fichier cron/jobs.json, copie de tâches, nouveau store, scheduler ou daemon. La projection métier reste celle des propriétaires existants ; le nouvel entrypoint ne remplace pas cron.list.

La révision est SHA256 des tuples `(job_id, enabled, job_json, schedule_identity)`, sélectionnés dans une transaction de lecture et ordonnés par sort_order, puis job_id comme départage déterministe. Chaque tuple est encodé JSON UTF8 compact, précédé de sa longueur en huit octets, puis ajouté au digest. Les valeurs exactes job_json sont conservées pour la révision, sans déduction métier. state_json et runtime_updated_at_ms ne sont jamais sélectionnés. Leur changement ne modifie donc pas la révision ; changer une instruction/configuration, enabled ou schedule_identity l'invalide.

Le helper read_db existant reçoit des bornes optionnelles, sans modifier les défauts de ses autres callers : busy timeout20ms, budget SQL50ms, 8192 lignes, 8Mio de champs/encodages cumulés, 256Kio par champ. Préflight SQL de tailles avant lecture de contenu ; inconnues, dépassement, verrou, absence, corruption ou mauvais schéma donnent sourceRevision:null. Aucun contenu, nom de tâche, paramètre ni exception brute n'est imprimé ou journalisé. Les seuls champs de sortie sont `{schemaVersion:1,sourceRevision:hex64|null}`.

## Core Control et absence de source

Core appelle ce propriétaire via les playbooks épinglés, avec un probe de100ms, stdout2048octets et killSignal SIGKILL. Les probes simultanés partagent un seul processus en vol. Aucune révision en mémoire ne devient une source canonique : le probe est refait à chaque lecture et après collecte pour l'invalidation. Un changement de racines ne partage pas le résultat d'une autre racine.

Le correctif d'urgence de Claude reste intact : sans révision lisible ou avec un propriétaire ancien ne reconnaissant pas le flag, la section fait une lecture normale ; elle ne demeure pas deferred pour source_revision_unavailable. Une révision disponible sert à la clé/cache et au contrôle avant livraison. Le pool existant continue la collecte lente ; le fast path répond en attente après180ms puis sert le cache prêt. Aucun changement d'action scheduler, de paiement ou de registre d'opérations.

## Route existante et capability

| Route | Budget | Capability |
| --- | --- | --- |
| GET /v1/control/automations?contract=2 | Cible R5 :300ms ; acceptance existante :1s | NO_CAPABILITY temporaire pour la projection owner Control existante ; aucune information/action agent ou voix ajoutée par ce lot. |

Aucun faux identifiant de capability ni outil parallèle. Le mapping canonique de la surface agent/voix relève du registre existant et doit être confirmé avant une nouvelle exposition. Il n'y a pas de nouvelle route : sa ligne acceptance est déjà présente et son budget n'est pas augmenté.

## Tests, captures et activation

Les tests SQLite locaux emploient uniquement les noms de colonnes attestés par fichier29, dans une base synthétique : ce n'est pas un export du schéma/types/index ni des lignes réelles S24. Huit tests owner vérifient horloge/state stables, changement de chaque champ de configuration et ordre, 1001 tâches, lecture sans modification des octets/fichiers, verrou, source absente/corrompue/symlink, dépassement et CLI digest-only. Le test Core utilise un owner synthétique lent2,4s, vérifie le budget300ms cold/cache, partage de lectures, invalidation, guard en cours de calcul et repli normal. Son résultat local n'est pas une mesure S24 ; les valeurs ne servent pas de capture réelle.

Les nouveaux tests sont inscrits dans documentation.yml (owner) et ci.yml (Core), en conservant toutes les étapes. Captures réelles et recette/mesures S24 sont obligatoires avant fusion/activation : merge_eligibility:blocked. Playbooks doit être relu, fusionné et épinglé d'abord, puis Companion, après levée des preuves manquantes. R22 reste un lot séparé.

Retour arrière : retirer ces commits isolés sous revue. Après qualification, Claude seul utilise activate-ui-playbooks.sh et companion-deploy.sh avec SHA précédemment recettés, préflight/acceptance/rollback automatique/reçus. Aucun S24, secret, fusion, déploiement ou paiement par Codex.
