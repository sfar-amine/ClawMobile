# R5-bis — Révision SQLite des automatisations

Source réelle : captures S24 du 10/10 publiées dans core #82 (`a9f08e5`), schéma `cron_jobs` STRICT, clé primaire `(store_key, job_id)`, 17 jobs et 59 reçus. La paire est playbooks #38 puis Companion #78 : Claude fusionne/épingle le propriétaire d'abord. Ce lot est prêt à relire, sans déploiement ni qualification de ses nouveaux commits sur le S24.

## Propriétaire et digest

`python3 -m reporting.control_snapshot --automation-revision` réutilise le propriétaire reporting. Lecture `mode=ro`, `query_only`, transaction, de `state/openclaw.sqlite` dans OPENCLAW_STATE_DIR ou ~/.openclaw. SHA256 des tuples `(job_id, enabled, job_json, schedule_identity)`, ordre sort_order puis job_id ; JSON UTF-8 compact avec longueur préfixée sur huit octets. `state_json` et `runtime_updated_at_ms` ne sont jamais lus. Une identité nullable est acceptée. Le schéma réel n'autorise pas job_id nul. Plusieurs store_key rendent la source ambiguë : sourceRevision:null, lecture Control normale, sans choisir ni mélanger les magasins.

Bornes : 8192 lignes, 8 Mio cumulatifs, 256 Kio par champ, timeout SQLite 20 ms et budget SQL 50 ms. Préflight des tailles avant contenu ; absence, verrou, corruption, lien symbolique, schéma inconnu ou bornes dépassées donnent une révision nulle. La réponse ne contient que schemaVersion et sourceRevision, aucun texte de job, paramètre, exception ni secret.

## Probe et route existante

Core exécute uniquement le propriétaire des playbooks épinglés, une collecte de révision partagée en vol, réponse 2 Kio maximum. Les mesures réelles sont 35,38 ms au premier digest, 2,41–2,55 ms chauds, démarrage Python 93 ms. Le timeout du probe est donc **200 ms**, et la fenêtre d'attente du collecteur **80 ms**, cible route 300 ms. L'ancien timeout de 100 ms aurait exclu le probe à froid observé. La révision est relue après collecte pour refuser un résultat invalidé.

Sans révision lisible, le correctif d'urgence conserve la lecture normale, sans boucle deferred. Avec révision, le pool Control existant calcule en arrière-plan et partage les polls, puis sert son cache. Une révision n'est jamais persistée dans un nouveau store.

| Route existante | Budget acceptance | Cible | Capability |
|---|---|---|---|
| GET /v1/control/automations?contract=2 | 1 s, ligne existante conservée | 300 ms avec révision lisible | NO_CAPABILITY projection owner interne ; V6 traite son exposition agent/voix séparément |

Aucune nouvelle route, mutation scheduler, opération métier, protection paiement, capability ou daemon.

## Preuves et limites

Fixture nettoyée réelle : `cron-state.sqlite` et `measures.json`, core `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/r5-bis/`, copiées à l'identique sous playbooks `tests/fixtures/s24-2026-10-10/r5-bis/`. Le digest attendu sur cette base nettoyée est `44de239b50b70f15cedb18841179e3af974defc9d4f193cb261a8578536ad342`, distinct de la base privée.

Onze tests du vrai propriétaire vérifient digest, STRICT/PK, lecture immuable, invariance horloge/state, changement configuration/ordre, identité nulle, multi-store, volume généré 1017 jobs, verrou, source absente/corrompue/symlink et bornes. Le test HTTP Companion emploie la base réelle et rejoue les latences capturées (collecteur 2475 ms et probe froid 128,38 ms), sans prétendre installer le code sur le téléphone : cold/cache sous 300 ms, single-flight, invalidation, knownRevision, force et repli normal. Tous inscrits dans leurs workflows ; étapes de base conservées par union.

Les captures de la production précédente montrent 1729–4557 ms froids et 2–8 ms en cache. Le collecteur froid dépasse le budget ; cette PR protège sa façade quand la révision est lisible, sans accélérer artificiellement la collecte. En repli normal, une collecte lente peut encore dépasser le budget. Claude mesure/recette les nouveaux commits après pin et déploiement, seuls résultats qui prouveront la latence en production.

Retour arrière : revert des commits du lot sous revue, ou pin/déploiement de SHA recettés par Claude via activate-ui-playbooks.sh / companion-deploy.sh. Codex ne fusionne, n'active ni ne déploie.
