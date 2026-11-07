# S24 07/11/2026 — Orange refusé sur un tour écrit de l'app

Capture en lecture seule sur le S24 (Companion 1bf6ca93) :

- `runStatus` : `GET /v1/runs/run_1794064014193_f0987f1c` tel que servi par le Companion déployé (« mon solde orange »
  partagé depuis l'app à 16:06). Pas de champ d'origine du tour.
- `routeHealth` : dernier échec des deux routes Orange dans `~/.openclaw/skill-intelligence/route-health.json`. À 15:17,
  `network_snapshot_unavailable` ; à 16:07, `orange_cellular_required_wifi_kept` (Wi-Fi gardé comme pour une voix en direct).
- `playbooksRuntime` : SHA-256 des fichiers installés qui fixent la restriction (`maxit_guarded_service.py`,
  `capability_graph.py`, `execution_graph.json`) ; `executionGraphSurfaces` : types `claw_live` = voice, `samantha_android` = app.

Aucun numéro, solde ni secret. Utilisée par `scripts/test-typed-app-surface.cjs`.

## 17:54 — après le déploiement de core#563 (5067c458)

`registry-and-busy-companion.json`, capture en lecture seule sur le S24 :

- `registryRow` : la ligne du tour `run_1794070429687_2980847e` (« mon solde orange » partagé depuis l'app) dans
  `~/.openclaw/clawmobile-companion/runs.json`, écrite avant l'envoi du tour. Pas de `voiceDelegation` : c'est un tour écrit.
- `dialogueDecision` : la décision enregistrée par le dialogue pour ce même tour (`samantha-dialogue/dialogue.sqlite`) :
  bon identifiant de tour, mais surface `claw_live`. L'outil typé a donc reçu la restriction voix.
- `routeHealth` : le refus du garde à 17:54 (`orange_cellular_required_wifi_kept`, Wi-Fi jamais coupé), identique à 16:07.
- `probeLongTurn` : `GET /v1/runs/<id>` toutes les 200 ms pendant un tour écrit anodin (« Quelle heure est-il ? », 47 s).
  Les six premières lectures répondent en 0,08-0,22 s, puis plus aucune réponse en 3 s (`000`) pendant environ 40 s.
  Sur ces lignes `000`, les colonnes d'état reprennent la dernière réponse reçue (rien n'a été écrit).
- `probeShortTurn` : même sonde sur un tour de 7 s : toutes les lectures répondent en moins de 0,5 s. Le blocage est intermittent.
- `registryFile` : taille réelle du registre (1 018 677 octets, 386 tours). Lecture et analyse avec le Node de la passerelle : 12-17 ms.

La recherche HTTP de 1,5 s retombait donc sur `claw_live` dès que le Companion était occupé. L'outil lit maintenant la
ligne directement dans le registre, remplacé de façon atomique (fichier temporaire puis renommage).
