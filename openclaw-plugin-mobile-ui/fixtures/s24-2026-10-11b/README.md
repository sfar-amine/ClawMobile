# Captures S24 du 10–11/10/2026, vague 5b (Claude)

Ces fichiers ont été capturés par Claude sur le S24 entre 23:30 et 00:05 UTC, via le connecteur Claw (`claw_exec`). Ils ont été nettoyés sur le téléphone, puis recopiés ici. L'empreinte sha256 de chaque fichier a été vérifiée identique entre le téléphone et Git.

État au moment de la capture :
- OpenClaw `2026.9.6 (eb377ac)` ;
- core `~/ClawMobile` @ `5de1c49` (branche `runtime/samantha-companion-private`) ;
- playbooks épinglés `6d567aa` ;
- release tier0 `20261010T120821-d3beb769` ;
- charge entre 3,8 et 6,8, MemAvailable entre 2,4 et 3,1 Go.

Une autre session écrit dans `s24-2026-10-11/`. Ce dossier `s24-2026-10-11b/` lui est indépendant.

## Règles suivies

- **Une seule mutation**, celle du point E1 : une automatisation jetable, créée désactivée, modifiée puis supprimée. Preuve de suppression dans `e1/deletion-proof.json`.
- Partout ailleurs, lecture seule :
  - SQLite ouvert en `?mode=ro` ;
  - `GET` loopback avec l'en-tête de l'app (`Connection: close`, sans Origin ni en-tête propriétaire) ;
  - lecture de `dist/` et de fichiers.
- Aucun appel `agents.files.set`, aucun reçu Remote Bridge relu par la route Companion (cette lecture le normaliserait), aucun paiement, aucun appel de modèle, aucune consultation opérateur.
- Un seul job lourd à la fois. Les commandes de plus de 25 s ont été détachées puis lues.

**Nettoyage :**
- Les UUID et les suites hexadécimales de 16 caractères ou plus sont hachés avec un sel aléatoire, en gardant leur format. Le sel est resté sur le téléphone.
- Les numéros deviennent des E.164 fictifs distincts `+2160000000N`, ou `<peer>` dans les clés de session.
- Les e-mails deviennent `owner@example.invalid`.
- Les textes libres deviennent `<texte N car.>`.
- Recherche finale faite sur le téléphone : `@`, `sk-`, `Bearer`, `ghp_`, `eyJ`, `+216[1-9]`, `+33`, `apiKey`, `password`.
  - Il ne reste que `owner@example.invalid`.
  - Les identifiants `task-…` ont été renommés `t_…` pour ne pas ressembler à `sk-`.

## `e1/` — E1 / R23 (core #89) : `cron.get` / `cron.update` réels

- `cron-lifecycle.json` donne les 9 appels `openclaw gateway call`, dans l'ordre, avec params, code de sortie, latence et réponse :
  1. `cron.add` : `claude-e1-capture-2332`, `enabled:false`, `0 4 1 1 *`, payload `agentTurn` neutre ;
  2. `cron.get` ;
  3. `cron.update` : renommage et nouvelle planification `30 5 2 1 *`, avec `expectedConfigRevision` ;
  4. `cron.get` ;
  5. `cron.update` avec l'**ancienne** révision, refusé en `CRON_JOB_CHANGED` ;
  6. `cron.get` ;
  7. `cron.remove` ;
  8. `cron.get`, qui renvoie `CRON_JOB_NOT_FOUND` ;
  9. second `cron.remove`, qui renvoie `CRON_JOB_NOT_FOUND`.
- `deletion-proof.json` relit `state/openclaw.sqlite` (`mode=ro`) :
  - 0 ligne `cron_jobs`, `cron_run_receipts` ou `cron_job_scratch` porte l'id ;
  - 0 nom `claude-e1-capture-%` ;
  - 17 jobs avant comme après ;
  - empreintes `job_json` des 17 autres jobs identiques avant et après (`definitions_unchanged: true`).
- Faits utiles pour E1 :
  - **Il existe un CAS natif.** `cron.update` accepte `expectedConfigRevision` (jeton opaque `sha256:<base64url>`, renvoyé dans `configRevision` par `cron.add`, `cron.get` et `cron.update`). Une révision périmée est refusée avec `details.code = CRON_JOB_CHANGED`, `expectedConfigRevision` et `actualConfigRevision`, et `retryable:false`.
  - `cron.update` renvoie le job complet.
  - Un `cron.update` de planification ajoute `state.scheduleActivatedAtMs`.
  - Par défaut, `cron.add` ajoute :
    - `payload.toolsAllow:["*"]` ;
    - `delivery.mode:"announce"` ;
    - `scheduledToolPolicy {version:1, mode:"trusted"}` ;
    - à la création seulement, un `deliveryPreview`, ici « no route, will fail-closed ».
  - Latences CLI de 2,9 à 6,4 s (création 6,4 s ; get, update et remove de 2,9 à 3,9 s).
  - Schéma installé : `src-BRUl7oDv.mjs`, `CronUpdateParamsSchema` (`patch` fermé, `expectedConfigRevision` optionnel) et `cronIdOrJobIdParams` (`id` ou `jobId`).

## `e3/` — E3 (core #91) : `agents.files.set`, sans écriture

- `agents.files.schema.installed.mjs.txt` : schémas installés, extrait verbatim. Les paramètres de `agents.files.set` sont `{agentId, name, content, expectedHash?}` (sha256 hexadécimal sur 64 caractères), en objet fermé.
- `agents.files.set.handler.installed.mjs.txt` : handler installé et file d'écriture, extrait verbatim.
  - **CAS sur `expectedHash` :** le handler compare le sha256 du fichier courant **dans** `enqueueWorkspaceFileUpdate`. C'est une chaîne de promesses en mémoire, propre au process Gateway. En cas d'écart, il renvoie `INVALID_REQUEST` avec `details.type = "agent_file_conflict"` et `currentHash`. Si le fichier est absent, `currentHash` est indéfini, donc tout `expectedHash` est en conflit.
  - Cette atomicité ne vaut **qu'entre appels `agents.files.set` du même process Gateway**. Un autre écrivain du même fichier n'est pas sérialisé, par exemple `install-openclaw-instructions.sh` ou un outil de l'agent.
  - Sans `expectedHash`, l'écriture est inconditionnelle.
  - Le contenu est borné à 2 Mio.
- `agent-files-facts.json` :
  - **Noms autorisés** : `ALLOWED_FILE_NAMES = AGENTS.md, SOUL.md, IDENTITY.md, USER.md, BOOTSTRAP.md, MEMORY.md`.
  - **`DREAMS.md`** est présent (22 979 octets), écrit par OpenClaw dreaming via le job « Memory Dreaming Promotion ». Il est **hors liste** : `agents.files.get` renvoie `unsupported file "DREAMS.md"`, et `set` le refuserait de même. `TOOLS.md` est absent et également refusé.
  - **Sauvegardes** : la Gateway **n'en fait aucune** avant écriture. Les seules sauvegardes du workspace sont :
    - 6 `AGENTS.md.bak-ui-playbooks-*`, produites par `ui-playbooks/install-openclaw-instructions.sh` (ligne 11, `cp -p`, sans borne) ;
    - 4 copies manuelles du 24/09.
  - Il n'existe aucun propriétaire « 5 sauvegardes ».
  - **Instructions de paiement** : lignes qui correspondent au motif paiement de `automations.ts`, comptage seulement :
    - `AGENTS.md` : 2 ;
    - `SOUL.md` : 1 ;
    - `DREAMS.md` : 2.

    `agents.files.set` n'a **aucune garde de contenu**. Il réécrirait `AGENTS.md` ou `SOUL.md` sans condition. La seule garde existante est côté lecture, dans `fileReadBoundary.ts` du Companion.

## `f4/` — F4 (core issue #97) : notifications de l'app

- **Entrypoint canonique** : l'écran Notifications de l'app ne lit pas `/v1/notifications/sources`. Il lit `GET /v1/runs?limit=40&summary=1`.
  - Cette route est servie par `runs.ts`, à partir de `~/.openclaw/clawmobile-companion/runs.json` : 403 Ko, 17 runs.
  - `NotificationsScreen.kt` (`notificationRuns(history)`) affiche `title = run.request` et `body = ResultText.display(run.result)`.
- Le texte à structurer est donc `runs[].result`. `runs.summary.notifications.json` est la réponse réelle, en masquage de structure : lettres → x/X, chiffres → 0, ponctuation, espaces et `**` conservés. Sur les 17 runs :
  - **3 en Markdown** (`**…**` en ligne) ;
  - **6 en JSON brut** (`{"ok": true, "provider": …}`, `level_percent`…). Ce sont les « dumps clé=valeur » vus dans l'app, que `ResultText` aplatit en `clé: valeur` ;
  - 5 en texte simple ;
  - 3 vides ou de voix interrompue.
- Aucun `result` ne contient de saut de ligne dans cet échantillon.
- Les reçus d'incident (`~/.openclaw/incidents/queue/*/message`, 25 entrées, 24 à 281 caractères) ne contiennent ni Markdown ni `clé=valeur`.

## `f5/` — F5 (core issue #96) : « 16 sur 18 · System maintenance »

- `health-correlated-window.json` : collecte ponctuelle en lecture, 18 relevés d'une minute entre 23:43:35 et 00:00:35 UTC. Elle croise :
  - `current.json` ;
  - `maintenance-last.json` ;
  - `transaction-health.json` ;
  - `scheduler-health.json` ;
  - l'âge des heartbeats ;
  - `GET /v1/control/health?contract=2` au même instant (`dataRevision`, `sourceCheckedAt`).

  S'y ajoutent les lignes de `health.log` de la fenêtre et l'état final des échecs de transaction.
- `health-owners.installed.txt` : extraits verbatim de `health-verdict.py`, la copie exécutée par la release, identique à core, et de `skill_intelligence/transaction_health.py` (pin).
- **Constat** : 16 sur 18 tout au long de la fenêtre, avec les deux mêmes composants non sains.
  - `control_plane.maintenance` passe :
    - de `degraded / transaction_health` à `stale / maintenance_receipt_stale` à 23:52 (reçu de plus de 660 s) ;
    - puis revient à `degraded` à 23:57, après la maintenance de 23:55.
  - `transactions.runtime` reste `degraded`, ou `stale` entre 23:53 et 23:56.
- **Propriétaires** :
  1. La maintenance tourne toutes les **900 s**, mais le verdict la juge périmée après **660 s**, et `checked_at` est l'heure de **début**. Le passage en `stale` est donc systématique, environ 5 min par cycle.
  2. `transaction_health.py` met `status = degraded` tant qu'une signature compte au moins 2 échecs dans les 3 600 s. WhatsApp en a accumulé 87, puis 92 en fin de fenêtre : la maintenance reste « degraded » tant que des erreurs WhatsApp reviennent dans l'heure. Le verdict revient à 18 sur 18 après une heure calme.
  3. Écart entre les deux : `health-verdict.py` compte `repeated_failures` (`count >= 2`) **sans** la fenêtre de 3 600 s du propriétaire. Voir les colonnes `countedBy*`.
- **Aucun historique de verdicts n'existe** : `current.json` est réécrit, et `health.log` ne trace pas ces deux capabilities.

## `f6/` — F6 (core issue #95) : reçus Remote Bridge bloqués

- `remote-bridge-stuck-receipts.json` contient 16 reçus bloqués :
  - 15 `running` : 14 `exec_wait`, 1 `mcp_capability_execute_owner` ;
  - 1 `indeterminate`.

  Tous ont `mutationRisk:"unknown"`, entre 4,2 h et 250,9 h. Une 17ᵉ ligne est la requête de cette capture elle-même, marquée `note` et exclue.
- **Propriétaire** : `remoteBridge.ts`, où `INSTANCE_ID = pid-startMs-rand`.
  - Chaque reçu bloqué porte une **instance différente**, dont le **pid n'existe plus**. Ils ont donc été abandonnés au redémarrage de leur Companion.
  - La normalisation en `indeterminate` (`normalizeStaleReceipt`) n'a lieu qu'à la **relecture**, par `getRemoteBridgeRequest` ou par un rejeu du même `requestId` ou `taskId`/`stepId`. Elle n'est pas faite par un cycle. Aucun de ces reçus n'a été relu.
- **Non-application ou effet incertain** :
  - Aucun reçu n'est vérifiable comme non appliqué : tous ont atteint `running`, donc le dispatch a commencé.
  - Ce qui est prouvé, c'est l'**absence d'effet en cours** : aucun script `processes/cmd-*.sh` lié n'apparaît dans la ligne de commande d'un process vivant, et aucun pid d'instance n'est vivant.
  - L'effet passé reste `unknown`.
- Aucun état n'a été modifié.

## `c8/` — C8 (core #77) : fenêtres 272 000 / 128 000 contre 200 000 du CLI

- `sessions-cli-vs-sqlite.main.json` : jointure ligne à ligne de `session_nodes.entry_json` (`mode=ro`) et de `openclaw sessions --json --limit all`, en 2,9 s. Il y a 87 lignes de l'agent `main` (84 la veille).
- `context-tokens-rule.installed.mjs.txt` : la règle installée, extrait verbatim.
- **Règle constatée** : le CLI expose **200 000 pour les 87 lignes**, que la fenêtre stockée soit 272 000, 1 048 576, 128 000, 200 000 ou absente.
  - `resolveProjectedSessionContextTokens` ne fait confiance à `entry.contextTokens` que si `contextTokensSource` vaut `"runtime"` (même fournisseur, modèle et harness), ou `"resolved-v1"`.
  - Or les lignes S24 portent `"resolved"`, ou n'ont pas de source.
  - `resolveModelContextTokenProjection` ne résout rien (`allowAsyncLoad:false`) pour ces modèles.
  - La sortie retombe donc sur `configContextTokens = lookupContextTokens(defaults.model) ?? 2e5`, soit 200 000.
- **`totalTokensFresh`** vaut `true` seulement si `totalTokensFresh === true` **et** `totalTokensVersion === 1`. Exemples : `node-14840b9f0702` (`fresh:true`, sans version) sort `false` ; 20 lignes sans `totalTokens` sortent `totalTokens:null` et `false`.
- `totalTokens` est recopié tel quel.

## `h10/` — H10 (core #114) : 11 réponses publiques de l'app

Ce sont des appels `curl` sur le loopback `127.0.0.1:8765`, avec l'en-tête de l'app. Pour les routes différées, la capture relance toutes les 500 ms jusqu'au résultat, comme l'app. Le premier appel (`warming`/`deferred`) est conservé dans `_capture.firstCall`.

| Fichier | Route | Statut | Latence finale | Note |
|---|---|---|---|---|
| `files.agent.json` | `/v1/files?scope=agent` | 200 | 9 essais, 7,3 s | 4 fichiers |
| `files.session.json` | `/v1/files?scope=session` | 200 | 11 essais, 8,1 s | 14 entrées |
| `files.content.agent-AGENTS.md.json` | `/v1/files/content?scope=agent&path=AGENTS.md` | 200 | 5 essais, 3,8 s | `redacted:true`, texte masqué |
| `files.content.session-IDENTITY.md.json` | `/v1/files/content?scope=session&path=IDENTITY.md` | 200 | 6 essais, 4,4 s | texte masqué |
| `usage.json` | `/v1/usage` | 200 | 3,8 s | premier appel froid : `usage_source_unavailable` en 5,9 s |
| `providers.json` | `/v1/providers` | 200 | 0,27 s | `updatedAt` ISO |
| `usage.details-cost.json` | `/v1/usage?details=cost` | 200 | 0,08 s | premier appel froid à 16,7 s ; `cost.state` reste `unavailable` |
| `skills.candidates.json` | `/v1/skills/candidates?limit=50` | 200 | 0,21 s | vide réel |
| `skills.clawmobile-capabilities.json` | `/v1/skills/clawmobile-capabilities` | 200 | 3,1 s | **dates en epoch** : `updatedAt` et `history[].timestamp` = `1791655375494` (ms) |
| `whatsapp.allowlist.json` | `/v1/whatsapp/allowlist` | 200 | 4,3 s | 5 contacts, E.164 fictifs |
| `whatsapp.allowlist.history.json` | `/v1/whatsapp/allowlist/history?limit=50` | 200 | 0,21 s | vide réel |

Dates : `usage` et `providers` frais sont en **ISO**. La seule date epoch rencontrée est celle de `skills/clawmobile-capabilities`.

## `j1/` — J1 (core #117) : racines pour `--secret-root`, chemins seulement

`secret-roots.paths.json` :
- **Core** : `~/ClawMobile`, un checkout simple, d'où tournent le Companion et `companion-deploy.sh`.
- **Playbooks épinglés** : realpath de `~/.openclaw/runtime-ui-playbooks/current`, soit `…/6d567aa…`, worktree détaché de `~/.openclaw/workspace/ui-playbooks/.git`. 23 autres worktrees `<sha>` sont des doublons à ne pas scanner. Le checkout de travail `workspace/ui-playbooks` a changé de HEAD pendant la session ; ce n'est pas la version épinglée.
- **Journaux autorisés** : `~/.openclaw/deploys`, `~/.openclaw/workspace/logs`, `~/.openclaw/health` et `~/.openclaw/logs`. Ce dernier contient des journaux d'essais de paiement du 05/10 ; à décider.

## `p0-4-5b/` — P0-4/5 (core #81) : RSS

- `rss-current-and-history.json` donne les valeurs courantes :
  - Companion : 185 Mio RSS, HWM 192 Mio ;
  - Gateway : 1,53 Gio RSS, HWM 2,21 Gio, swap 592 Mio ;
  - MemAvailable : 2,35 Gio.
- Historique disponible :
  1. 15 événements `diagnostics/memory` natifs de la Gateway depuis son démarrage, de 16:09 à 23:46 : RSS de 1,23 à 1,80 Gio, `rss_threshold` et `rss_growth`. Le journal est tronqué à chaque démarrage.
  2. 4 bundles de stabilité OpenClaw : RSS de 1,08 à 1,60 Gio et max de 1,51 à 1,81 Gio aux arrêts.
  3. **Aucun historique pour le Companion.**
- `gateway-memory-thresholds.installed.mjs.txt` : la Gateway a déjà un propriétaire natif de seuils.
  - Avertissement RSS à 1 536 Mio, critique à 3 072 Mio, plafonnés par la mémoire du process.
  - Croissance de 512 / 1 024 Mio sur 10 min.
  - Répétition toutes les 5 min.
  - Paramètres `thresholds?.…` surchargeables.
- Dans les événements, `threshold` est en Gio pour `rss_threshold` et en Mio pour `rss_growth`.

## Intégrité

`SHA256SUMS` liste les sha256 des 25 fichiers de capture. Ils ont été calculés sur le téléphone (`$PREFIX/tmp/cap2b/out/`) puis recalculés ici : tous sont identiques.
