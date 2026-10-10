# Captures S24 du 10/10/2026 (règle P0-2)

Ces fichiers ont été capturés par Claude sur le S24 (Companion `a841936`, playbooks `2ba0e72`), puis nettoyés sur le téléphone avant d'être publiés.

## `control/` : Contrôle contrat 2, réponses réelles du Companion
- `health.json` : `GET /v1/control/health?contract=2`. Composants réels avec leurs libellés R1 (`label.fr` et `label.en`), 18 sur 18.
- `requests.json` : `GET /v1/control/requests?contract=2`, environ 40 Ko.
- `automations.json` : `GET /v1/control/automations?contract=2` (R5).
- `latency.txt` : latences mesurées sur le S24 au moment de la capture.

**Nettoyage.** Les identifiants, statuts, références, dates, révisions et libellés `fr`/`en` sont conservés. Tout autre texte libre (titres, descriptions…) est remplacé par `<texte N car.>`. Les numéros sont masqués en `+21600000000`. Une recherche de secrets a été faite avant publication.

## `r8/` : format réel de `skill_candidate.json`
Ce sont les 5 seuls `skill_candidate.json` présents sur le S24, produits par le vrai code `trace_induction` lors des essais du 02/10, à partir de traces de démonstration (`mock_trace`, app d'exemple). **Le S24 n'a aucun dossier `<workspace>/recordings/` réel** : aucune démonstration réelle n'a encore été enregistrée.

Conséquence pour R8 :
- le format (`schema_version: clawmobile.skill_candidate.v1`, `steps[]`, `validation`…) est celui que le code réel produit ;
- le volume réel est **0**. Le test au-delà de 500 dossiers reste un test de bornes, généré à partir de ces formes.

## `gateway/` et `r17/` : réponses réelles de la Gateway OpenClaw 2026.9.6 et schéma R17

**Provenance.** Capturé le 10/10/2026 sur le S24 (Termux), avec OpenClaw `2026.9.6 (eb377ac)`. Les appels ont été lancés un par un via `timeout 60 nice openclaw gateway call <méthode> --params '<json>' --json`, en lecture seule (aucun appel set/patch/update/resolve/remove/run). Les noms de paramètres ont été vérifiés dans les schémas TypeBox de `dist/` avant les appels. Chaque fichier a la forme `{ "_capture": {method, params, latencyMs, …}, "response": … }`. La latence est le temps total mesuré de la commande CLI, démarrage de Node compris (environ 2 s).

| Fichier | Méthode | Params | Latence |
|---|---|---|---|
| `gateway/sessions.list.json` | `sessions.list` | `{"limit":5}` | 2376 ms |
| `gateway/config.get.json` | `config.get` | `{}` | 4766 ms |
| `gateway/models.list.json` | `models.list` | `{}` | 2419 ms |
| `gateway/models.list.view-configured.json` | `models.list` | `{"view":"configured","includeDefaultModels":true,"includeDetails":true}` | 3519 ms |
| `gateway/models.authStatus.json` | `models.authStatus` | `{}` | 2608 ms |
| `gateway/usage.cost.json` | `usage.cost` | `{"days":30}` | 7651 ms |
| `gateway/usage.status.json` | `usage.status` | `{}` | 3335 ms |
| `gateway/agents.files.list.json` | `agents.files.list` | `{"agentId":"main"}` | 4333 ms |
| `gateway/agents.files.get.json` | `agents.files.get` | `{"agentId":"main","name":"IDENTITY.md"}` | 3454 ms |
| `gateway/sessions.files.list.json` | `sessions.files.list` | `{"sessionKey":"<sessions.list[1].key>"}` | 3105 ms |
| `gateway/sessions.files.get.json` | `sessions.files.get` | `{"sessionKey":"…","path":"IDENTITY.md"}` | 2438 ms |
| `gateway/skills.status.json` | `skills.status` | `{"agentId":"main"}` | 1859 ms (2438, 1755) — ajouté pour P2-b, 18:35 ; 7 lignes workspace complètes + 3 lignes d'exemple sur 65 ; descriptions en `<texte N car.>` |
| `r20/sessions.list.main.json` | `sessions.list` | `{"search":"agent:main:main","limit":100}` | 3701 ms |
| `r20/sessions.files.list.main.json` | `sessions.files.list` | `{"sessionKey":"agent:main:main"}` | 1680 ms |
| `r20/sessions.files.list.main-search.json` | `sessions.files.list` | `{"sessionKey":"agent:main:main","path":"memory","search":"2026-10"}` | 2818 ms |
| `r20/sessions.files.get.main.json` | `sessions.files.get` | `{"sessionKey":"agent:main:main","path":"IDENTITY.md"}` | 1563 ms |
| `r17/inbound-schema.json` | sqlite `openclaw-agent.sqlite`, ouvert en `?mode=ro` | — | — |

**Nettoyage.** Il a été fait sur le téléphone, avant publication :
- Les e-mails deviennent `owner@example.invalid`.
- Les numéros deviennent `+21600000000` (et les suites de 8 chiffres ou plus deviennent `<peer>`).
- Les UUID et les suites hexadécimales sont hachés avec un sel aléatoire, sans changer leur format.
- Le texte libre (`content`, `label` de session, `title`…) devient `<texte N car.>`, et les noms de session ou de personne deviennent `<name>`.
- Le `hash` des fichiers est mis à zéro (64 « 0 »).
- Les champs secrets sont supprimés : apiKey, baseUrl, token, secret, cookie, authorization.
- `config.get` n'est **qu'un extrait** : `config.agents.defaults` (modèle, thinking, compaction) et `config.models`, sans apiKey ni baseUrl. Les arbres `raw`, `parsed`, `resolved` et `runtimeConfig` sont omis.

Sont conservés : les noms de champs, les types, les valeurs d'énumération, les compteurs de tokens, les tailles de contexte, les coûts, les identifiants de modèles et de fournisseurs, les booléens et les horodatages. Une recherche finale de `@`, `sk-`, `Bearer`, `token`, `+216[1-9]`, `apiKey` et `secret` a été faite : il ne reste que des noms de champs (`apiKeySupported`, `contextTokens`…) et `owner@example.invalid`.

**Points à retenir pour Codex :**
- `thinkingLevels` (`[{id,label}]`) et `thinkingDefault` sont donnés **par modèle** dans `models.list`, mais seulement quand `reasoning:true`. Le modèle principal `gpt-5.6-sol` ne les a pas : ni `reasoning`, ni `contextWindow`, ni `contextTokens`. Il faut donc prévoir leur absence. `sessions.list` les donne aussi dans `defaults` et dans chaque session, avec en plus `thinkingOptions: string[]`.
- Contexte : `contextWindow` (fenêtre du modèle) et `contextTokens` (budget effectif) dans `models.list` ; `contextTokens`, `totalTokens`, `totalTokensFresh`, `inputTokens`, `outputTokens` et `estimatedCostUsd` dans `sessions.list`.
- Modèle principal et repli : `config.agents.defaults.model.{primary, fallbacks[]}`. Dans `models.list`, les `tags` portent `"default"` et `"fallback#N"`. Disponibilité : `available` (booléen) par modèle, et `providerOutcomes[].status` par fournisseur.
- `usage.cost` donne seulement `daily[]` et `totals` (input, output, cacheRead, cacheWrite, totalTokens, `*Cost`, missingCostEntries) plus `cacheStatus`. **Il n'y a pas de détail par fournisseur ni par modèle.** Au moment de la capture, le cache était périmé (`staleFiles: 92`), donc les valeurs sont à 0.
- `agents.files.*` ne couvre que les fichiers d'amorçage (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, `MEMORY.md`). `IDENTITY.md` et `BOOTSTRAP.md` (après l'onboarding) n'apparaissent pas dans la liste, mais `get` fonctionne. Le contenu est limité à 2 Mio. Il n'y a pas de pagination.
- `sessions.files.list` : paramètres `{sessionKey, agentId?, path?, search?}`. Il renvoie `files[]` (fichiers lus ou modifiés selon le transcript) et `browser.entries[]`. Le navigateur est plafonné à 250 entrées (`truncated:true` au-delà) et la recherche à 500. Il n'y a ni curseur ni pagination. `sessions.files.get` renvoie `previewKind` `text`, `image` (base64 pour png, jpeg, gif, webp, avif) ou `unsupported`. L'aperçu est limité à 256 Kio, au-delà l'appel renvoie l'erreur `session_file_too_large`.

**R17.** L'horodatage canonique de réception d'un message WhatsApp entrant est `transcript_events.event_json → $.message.timestamp`, en epoch ms : c'est l'horodatage fourni par WhatsApp, à la seconde près. On le filtre avec `$.type='message'`, `$.message.role='user'` et `$.message.__openclaw.transport.channel='whatsapp'`. `transcript_events.created_at` est l'heure à laquelle la Gateway a enregistré le message. Voir `r17/inbound-schema.json` pour le schéma, la requête SQL, des lignes d'exemple et les réserves (`event_zstd`).

## Session principale de `main` (R20, ajout du 10/10 par Claude)
Les quatre fichiers `r20/*.main*.json` ont été capturés de la même façon pour R20 (#53), après vérification dans `dist/` que `sessions.list` accepte `search` et `agentId`. `sessions.list` filtré renvoie une seule ligne : `key:"agent:main:main"`, `isMain:true`, `agentId:"main"`. La clé et le `sessionId` sont conservés tels quels ; seule une sélection de champs de la ligne est publiée (pas de libellé, de participants ni de dernier message). La liste du workspace et le résultat de recherche sont publiés sans modification (noms de dossiers et de fichiers, tailles, dates). Le contenu de `IDENTITY.md` est remplacé par `<texte N car.>` et son `hash` mis à zéro. À noter : pour une recherche, le propriétaire renvoie `browser.path:""` même quand `path` est fourni.

---

# Vague 2 : captures demandées à Claude dans les PR brouillons (10/10/2026, 19 h 15–19 h 40, heure de Tunis)

**Provenance.** S24, OpenClaw `2026.9.6 (eb377ac)`, release Companion `20261010T120821-d3beb769` (current = LKG), playbooks installés `7070ea8`. Toutes les lectures sont en **lecture seule** : SQLite ouvert en `file:…?mode=ro` + `PRAGMA query_only=1`, fichiers lus, routes Companion `GET` en loopback sans en-tête propriétaire, Gateway via `openclaw gateway call` (méthodes de lecture, une à la fois). Aucun redémarrage, aucune mutation, aucun tour d'agent lancé, aucun paiement. Charge pendant les captures : 3,6 à 5,6 (`uptime`).

**Nettoyage** (fait sur le téléphone, puis revérifié avant commit) :
- Texte libre (`content`, `text`, `message`, `summary`, `label`, `userText`, `result`, `description`, `error`…) → `<texte N car.>`.
- Numéros → `+216XXXXXXXX` (ou `<peer>` pour une suite de 8 chiffres ou plus sans indicatif) ; e-mails → `owner@example.invalid`.
- UUID et empreintes hexadécimales (≥ 16) hachés avec un sel aléatoire, format conservé. Le sel est commun **à l'intérieur d'un même fichier** (et entre `c2/` et `c10/`), donc les références croisées (`id` ↔ `supersedes`, `source_ids`) restent cohérentes. Exceptions volontaires : `job_id` des tâches planifiées (r5-bis, r22) gardés en clair pour servir d'identifiants de recette ; SHA Git (40 car.) gardés dans `c9/`.
- Champs secrets supprimés ou masqués (`token`, `password`, `secret`, `cookie`, `apiKey`, `authorization`, signatures, nonces).
- Chemins `/data/data/com.termux/files/home` → `~`.
- Recherche finale : `Bearer`, `sk-`, `ghp_`, `github_pat_`, `AKIA`, `eyJ`, `PRIVATE KEY`, clés `*token*|*password*|*secret*`, `\+?\d{8,}` dans les chaînes, `@`, mots paiement : il ne reste que des noms de champs, des horodatages/tailles numériques et des empreintes hachées.

| Lot / PR | Fichier | Méthode | Fait mesuré |
|---|---|---|---|
| P0-1 #68 | `p0-1/gateway-handshake.json` | trames WS réelles autour du propriétaire `call-*.mjs` → `GatewayClient` (`health`) | `connect.challenge{nonce,ts,capabilities}` → `connect{minProtocol:4,maxProtocol:4,client{id:"cli",mode:"cli"},auth{token},role:"operator",scopes:["operator.read"]}` → `hello-ok{protocol:4,features{methods:468,events:64}}`. Aucun bloc `device` sur ce chemin (loopback + jeton partagé). Challenge→hello 16 ms, appel 9 ms, 910 ms au total avec l'import des modules. Refus structurés : `INVALID_REQUEST` (+`details.code=CRON_JOB_NOT_FOUND`), `FORBIDDEN/MISSING_SCOPE` avant dispatch. CAS/baseHash **non capturé** (exige une méthode d'écriture). |
| P0-3 #70 | `p0-3/reads-latency.json` + 10 réponses + `sessions.usage.json` | les 16 lignes `READS`, 2 tentatives | Tout passe sauf `/control/automations?contract=2` : **2 475 ms à froid pour un budget de 1 s** (4 ms en cache). `agent/config` 4,2 s, `whatsapp/allowlist` 4,3 s, `notifications/sources` 1,0–2,6 s. `sessions.usage {}` : 1 776 ms, 325 Ko bruts (listes réduites à 5). |
| C1 #71 | `c1/app-bixby-prompt-baseline.json` | `session_nodes.entry_json.systemPromptReport` | Mesure **avant** C1 (C1 non déployé, aucun tour lancé) : app 35 453–38 247 car. de prompt système, Bixby 32 573–38 233 ; `projectContextChars=0`, `injectedWorkspaceFiles=0` ; 11–39 k jetons d'entrée. |
| C2 #72 | `c2/memory-events-recent12.json` | `memory.db` events + `HYBRID_CONTEXT.md` (structure masquée) | Les **12 dernières décisions/checkpoints actifs (révisions 1905–1930) sont absents à 12/12** de HYBRID_CONTEXT ; section « Activité et décisions récentes » vide, `Coverage: BLOCKED — budget insuffisant` ; projection 24 213/24 576 octets, `coverage_complete:false`. |
| C5 #74 | `c5/voice-producers.json` | `memory.db` + scripts installés + registre | 0 événement `voice` ; seuls producteurs installés de `context-event.sh` : `autonomous-engineering-close.sh` et `learning-gate-close.sh` (surface `openclaw`). Aucun producteur voix canonique. |
| C7 #76 | `c7/private-sync-installed.json` | scripts installés + mapping | `sync-context-background.sh` (core `main` `bfb42ec`) n'appelle `save.sh` **que si le dépôt privé est déjà modifié** : les copies de `save.sh` ne sont jamais déclenchées sinon. `DREAMS.md` privé en retard (09/10 contre 10/10), `HYBRID_CONTEXT.md` privé du 26/09. 4 liens gérés workspace → dépôt privé (`memory/amine-inbox.md`, `contacts.md`, `whatsapp/contacts`, `voice/amine.md`), aucun lien dans le dépôt. |
| C8 #77 | `c8/session-nodes.json`, `c8/guardian-duration-before.json` | `session_nodes` des 4 agents | 937 lignes (692/161/84/0) ; lecture+parse SQLite 35–87 ms par agent ; Guardian actuel p50 4,97 s (3,1–9,0 s). Pression `main` jusqu'à 0,72 ; `totalTokens` absent sur 545 lignes, `totalTokensFresh:false` sur 12, `compactionCount` présent sur 2. |
| C9 pb#37 | `c9/maintenance-last.json`, `code-health.json`, `health-current.json`, `maintenance-duration-before.json`, `code-monitors-purity.json` | fichiers + `task_runs` | Maintenance p50 79 s (46–116 s), `maintenance-last.json` 21 635 octets, stdout tronqué à 16 000. 9 moniteurs sur 10 sont `unittest` ; 7 sans référence runtime (statique), `capability-graph` et `task-status` non prouvés purs. |
| C10 #80 / pb#39 | `c10/memory-events-200.json`, `c10/memory-core-native-7d.json` | `memory.db` + `plugin_state_entries` (memory-core) | 200 événements (192 récents + 8 sources de propositions) ; volume réel **1 933 événements**, 268 propositions ; `curator_last_run_v1` en mode `shadow`. Source native : `state/openclaw.sqlite.plugin_state_entries`, plugin `memory-core`, namespace `memory-host.events` (`memory.recall.recorded` = recalls, `memory.dream.completed` phases light/rem/deep), historique depuis le 28/09 → fenêtre 7 j complète. |
| R5-bis #78 / pb#38 | `r5-bis/cron-state.sqlite`, `r5-bis/measures.json` | schéma réel `cron_jobs` + `cron_run_receipts` (17 jobs, 59 reçus) | Schéma **STRICT, PK (store_key, job_id)**, `schedule_identity` JSON non nul sur les 17 lignes. Digest #38 : 35 ms à froid, 2,4 ms à chaud sur la vraie base ; digest de la fixture `44de239b…d342`. |
| R22 #79 | `r22/cron.status.json`, `cron.runs.*.json` | `openclaw gateway call` | `cron.status` 2,6 s ; `cron.runs` 1,6–4,7 s ; page non vide (total 299), vide, id inconnu et id invalide (`INVALID_REQUEST`/`CRON_JOB_NOT_FOUND`), erreurs toutes tâches (total 135). Source : `state/openclaw.sqlite.task_runs` (`source_id = jobId`). |
| P0-4/5 #81 | `p0-4-5/resources-inventory.json` | procfs + fichiers + SQLite | Gateway RSS 0,83–1,29 Go, swap 0,62–0,84 Go, pic 2,3 Go ; `/proc/loadavg` et PSI refusés (SELinux), charge lisible via `uptime`. 108 releases (102 Mo), `gateway.stderr.log` 36,6 Mo non borné, remote-bridge 6 459 reçus (15 `running` jusqu'à 245 h, 1 `indeterminate`), artefacts 320 Mo, plugin-captures 643 Mo dont 4 racines orphelines sans `owner.sqlite` (432 Mo) que la purge native ne touche pas. |
