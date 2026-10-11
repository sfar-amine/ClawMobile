# O6 (core) — le fast path attend la borne du garde

Jumelle core de playbooks #57 (O6). Décision du 11/10, prise par Claude sur les mesures S24
`openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/o6-network-guard-timing.json` :

| Couche | Valeur | Propriétaire |
|---|---|---|
| Consultation gardée, borne totale (verrou + préparation + DNS + service + nettoyage + restauration) | 60 s | garde réseau `CONSULTATION_TOTAL_S` (core #112, O1) |
| Attente du Capability Graph pour une entrée gardée | ≥ 65 s | `skill_intelligence/capability_graph.py` (playbooks #57) |
| Attente d'exécution du fast path pour une entrée gardée | 70 s | `model-fast-path.py` `GUARDED_ENTRY_WAIT_S` |
| Processus du helper côté Node (exécution) | max(budget, 70) + 15 s | `modelFastPath.ts` `fastPathProcessTimeoutMs` |
| Processus du helper côté `gemini_claw` | 90 s | `gemini-request.py` `FAST_PATH_PROCESS_TIMEOUT_S` |

Mesures : entrée gardée totale p50 5,6 s, p95 6,2 s, max 6,3 s (8 runs). Le bail du garde vaut 900 s, sans
renouvellement : la borne de 60 s se termine bien avant.

- Seule l'exécution d'une route dont l'entrée commence par `python -m telecom.maxit_guarded_service` est
  concernée ; les autres routes gardent leur budget (30 s par défaut). Le passage confirmé (`_execute_declared_handoff`,
  paiement) garde son budget : le parcours de paiement n'est pas modifié.
- Un appel de vérification seule (`--check`) garde son budget court.
- Aucune route, capability ou recette nouvelle : `companion-acceptance.py` sans objet.

Tests (CI, étape « O6 fast path waits… ») : `test-guarded-operator-wait.py` (capture du 10/10 09:41) et
`scripts/test-guarded-entry-wait.cjs`.

Recette live : avec O1/O3, par Claude ; une consultation gardée se termine dans la borne avec
`network_guard.restored: true`, sans abandon du fast path.

Retour arrière : revert de la PR.
