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
