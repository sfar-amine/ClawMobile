# Perf `/v1/usage` et `/v1/runs?limit=50` (11/10/2026)

Tâche imposée par AGENTS.md : toute route au-delà de 80 % de son budget dans un reçu devient une tâche d'optimisation.

| Route | Reçu | Mesure | Budget de recette | Cible |
|---|---|---|---|---|
| `GET /v1/usage` | `companion-20261011T064639` | 5,28 s (88 %) | 6 s (inchangé) | p95 ≤ 3 s |
| `GET /v1/runs?limit=50` | `companion-20261011T034317` | 3,82 s (96 %) | 4 s (inchangé) | p95 ≤ 2 s |

## Cause mesurée sur le S24 (lecture seule, clés `perf-usage-runs-*`)

- **Le coût dominant est le lancement du CLI `openclaw gateway call`, pas le Gateway.** `health` répond en 32 ms côté Gateway mais en 2,27 s côté CLI. `usage.status` prend 2,6 à 4,4 s, `sessions.list` 1,7 à 4,3 s et `chat.history` 1,9 à 2,8 s. P0-1 (#68, client Gateway persistant) n'est pas fusionnée : ce lot ne la duplique pas, il retire ces appels du chemin de la requête.
- `/v1/usage` : un seul `usage.status`, avec un cache de 60 s. Après chaque minute, la requête suivante payait un appel CLI complet : de 1,7 à 4,4 s mesurés, 5,28 s dans le reçu.
- `/v1/runs?limit=50` : sans run en cours, la lecture du registre prend 10 à 16 ms (`runs.json` = 416 Ko, 25 runs). Avec un run en cours, `sessions.list` passe par le CLI depuis que la migration SQLite a supprimé `sessions.json`. Cette lecture n'était pas bornée et précédait un budget séparé de 2,5 s pour les transcriptions. Le banc sur une copie du registre a donné 6,79 s et 6,47 s.

## Correction (propriétaires existants)

- `usage.ts` : le *last-good* de 10 min déjà en place sert de *stale-while-revalidate*. Après la minute, la dernière vue réussie répond immédiatement. Une seule lecture d'arrière-plan la revalide, avec le single-flight existant. `usage_source_stale` reste réservé à l'échec effectif d'une lecture, car l'app l'affiche comme « la lecture actuelle n'a pas abouti ». Au-delà de 10 min, rien d'ancien n'est servi.
- `server.ts` : une lecture `usage.status` au démarrage du Companion (`prewarmUsage`). Le premier `/usage`, souvent la recette post-déploiement, la rejoint au lieu de payer une lecture complète.
- `runs.ts` (`listRuns`) :
  - un budget unique de 1,5 s pour toute la partie « live » de la liste, compté depuis la requête ;
  - `sessions.list` borné à 5,5 s comme les autres lectures propriétaires, en single-flight, et réutilisé 10 s ; une session absente de l'index déclenche une relecture, et l'index déjà en mémoire répond pendant ce temps ;
  - au plus une lecture de transcription en vol par run, toujours limitée à 3 runs par liste ;
  - une lecture qui dépasse le budget continue en arrière-plan, et le résultat persisté sert le sondage suivant.
- Aucun nouveau store, démon, scheduler ni moteur de retry. Le registre `runs.json`, partagé avec les gardes de paiement, n'est pas modifié : sa lecture complète coûte 10 ms et n'est pas la cause.

## Mesures S24 avant / après

| Cas | Avant | Après |
|---|---|---|
| `/usage` chaque minute (`readUsage`, CLI réel) | 1 667 / 4 234 / 4 118 / 3 979 ms | 10 / 18 / 15 / 12 ms |
| `/usage` route, TTL expiré | 3 086 / 4 385 / 3 160 / 4 370 / 4 430 ms | servi depuis le *last-good*, ~10 ms |
| `/usage` premier accès après redémarrage | 4 081 ms (sans préchauffage) | 2 582 ms (préchauffage, arrivée à +1,5 s) |
| `/runs?limit=50` avec un run en cours | 6 789 / 6 465 ms | 1 504 / 1 502 / 1 501 ms, puis 251 / 6 ms |

Limite connue : sans *last-good*, c'est-à-dire juste après un redémarrage, le premier `/usage` attend le reste de la lecture CLI de démarrage. Cette attente reste sous le budget de 6 s, mais peut dépasser 3 s si le CLI dépasse environ 4,5 s sous charge. P0-1 (#68) supprimera ce coût.

## Tests

- `openclaw-plugin-mobile-ui/scripts/test-usage-runs-latency.cjs` (inscrit dans `ci.yml`) : vraie route HTTP, captures S24 (`usage.status`, `sessions.list`, registre terminal), volume de 100 runs, latences mesurées du 11/10 (`fixtures/s24-2026-10-11/perf-usage-runs-latency.json`).
- `test-recette2-server.cjs` et `test-read-etags.cjs` sont adaptés au *stale-while-revalidate* : la vue conservée répond immédiatement, et le marqueur ou l'ETag changent après la revalidation. Tous leurs invariants sont conservés.

## Retour arrière

Revert de la PR. Aucune donnée persistée nouvelle : le cache `usage` et l'index de sessions sont en mémoire.
