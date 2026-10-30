# Samantha Voix : une demande vocale ne finit jamais en silence (30/10/2026)

Incident S24 du 30/10 à 22:21 (core `799306da`, app `85e73729`). Amine demande à la voix « Quel est l'état de mes factures ». Le tour cerveau du Companion rend `state=pending` à 30 s (`brain_ms=30027`). Le run Gateway `run_1793395301758_9b29ce1e` se termine 0,4 s plus tard avec la réponse complète. Ensuite, rien n'est dit : ni annonce, ni réponse.

## Cause
- **La relecture A1 n'est enregistrée que pour un tour encore courant.** Dans l'app `85e73729`, `LiveVoiceSession.decideDuplexTurn` attend le reçu de `/claw-live/capability`. Il quitte ensuite la fonction si le tour cerveau n'est plus le tour courant ou s'il a été interrompu. Ce test passe avant `requestDeterministicReceipt` (qui lirait l'annonce) et avant `awaitReadback` (A1). Un tour retiré perd donc à la fois l'annonce et la réponse.
- **Le tour avait été retiré vers 14 s.** La mesure `[turn] surface=voice route=- … total_ms=14026` de 22:21:55.797 n'est écrite par l'app qu'à la clôture terminale d'un tour vocal (`saveDuplexTurn`). Elle part de la fin de parole : la clôture a donc eu lieu environ 14 s après le début de l'attente du cerveau, bien avant le reçu.
  - L'évènement exact (début de parole ou bruit, interruption, coupure du micro) n'a pas été lu : pas de logcat, aucun accès S24 pendant le banc vocal.
- **Côté Companion, aucun propriétaire pour un résultat différé.** `VoiceTurnProtocol` refuse le reçu d'un tour interrompu (`receiptRefused interrupted`) et ne savait rien du run qui continuait. La phrase d'attente promettait la discussion (« Je te l'écris dans la discussion. »), pas la voix.
- **La frontière des 30 s n'est pas la cause.** Pour un tour retiré, un reçu `done` arrivé à 25 s aurait été perdu de la même façon. Pour un tour encore courant, A1 lisait déjà le résultat après le délai.

## Changement (Companion, protocole voix v2)
- **Annonce.** À l'expiration du budget vocal, le reçu `pending` d'un tour cerveau dit « Je cherche encore, je te donne la réponse dès que je l'ai. » au lieu de « Je te l'écris dans la discussion. ». Cela vaut aussi pour l'app déployée, dont A1 lit ensuite la réponse quand le tour est resté courant.
- **Relecture différée, propriétaire unique : le protocole du tour vocal.**
  - `warmReady` v2 annonce `deferredReadback: 1`.
  - L'app souscrit tour par tour : `voiceTurn.deferredReadback: 1` dans le corps signé de `/claw-live/capability`.
  - Sans souscription (app `85e73729`), rien ne change : A1 reste le seul propriétaire, donc jamais deux lecteurs pour un même résultat.
- **Suivi du même run.** `delegateVoiceTurnToBrain` rend le reçu `pending` à 30 s, puis poursuit la même lecture bornée du même run :
  - cadence de 1 s, au plus 5 min ;
  - arrêt dès que la séance se ferme, qu'une demande plus récente remplace le tour ou que la réponse a été dite ;
  - le reçu terminal (même projection qu'avant le délai) est remis une fois au protocole.
  - Aucune nouvelle soumission, aucun store, scheduler, file ou retry.
- **`VoiceTurnProtocol`.**
  - Il garde ce reçu sur le tour source et émet `deferredReady` sur ce tour.
  - Nouveau contrôle `speakDeferred {operationId, sessionEpoch, turnId, sourceTurnId}`. L'app ouvre un tour de relecture (`voice-readback-<uuid>`, préfixe déjà admis) ; le texte n'est jamais celui de l'app.
  - Tant que le run travaille : l'annonce (le reçu `pending` du tour, mot pour mot), une seule fois.
  - Une fois le run terminé : sa réponse, une seule fois. Elle est lue en entier si elle tient en 600 caractères ; sinon, son début borné, suivi de « Le détail est dans la discussion. ».
  - `readbackAdmitted {deferred: "notice"|"result"}`.
- **Réponse arrivée avant la lecture du reçu.** Si la réponse arrive avant que l'app demande le reçu du tour encore courant (`receiptReply`), c'est elle qui est lue à la place de l'annonce, une seule fois.
- **Exactement une fois, jamais périmé.**
  - `readbackRefused {reason}` : `already_spoken`, `nothing_due`, `not_deferred`, `superseded`, `expired`, et `not_admissible` (quelqu'un parle ; c'est le seul refus à retenter).
  - Remplacement : un tour plus récent admis à l'exécution (une nouvelle demande, « stop » compris) remplace le tour différé, avec `deferredDropped {reason: "superseded"}` et l'arrêt du suivi. Un réflexe social (« merci », « attends ») ne s'exécute pas et n'annule rien.
  - Expiration : une réponse non dite 90 s après son arrivée est abandonnée (`expired`).
  - Barge-in : Amine qui parle pendant la relecture la coupe ; elle n'est jamais redite.
  - Séance fermée : rien n'est dit ; la réponse reste dans la discussion (propriétaire des runs inchangé).
  - Bornes : au plus 3 relectures ouvertes par séance, 64 tours, 512 opérations, comme avant.
- **Contrat partagé** `fixtures/protocol/voice-v2-app-companion.json` : `controls.speakDeferred`, `optionalWarmReadyFields.deferredReadback`, section `deferredReadback`. La copie de l'app sera alignée à l'identique par le lot APK.

## Changement app nécessaire (lot APK, non fait ici)
L'incident lui-même (tour retiré) n'est corrigé qu'avec l'app. Le Companion ne peut pas faire parler un tour que l'app a retiré ou ne connaît pas : l'app ignore les évènements d'un tour inconnu et la sortie d'un tour interrompu.
1. `voiceExecutionBody` : ajouter `voiceTurn.deferredReadback = 1` quand `warmReady.deferredReadback == 1`.
2. `decideDuplexTurn` : pour un tour cerveau dont le reçu est `pending` et porte `deferredReadback`, inscrire le tour source dans la liste A1 existante (`readbacks`), même s'il n'est plus courant ou a été interrompu. Seule condition : `generation == epoch`. Le `return@launch` actuel reste pour tout le reste.
3. Pour ces entrées, plus de suivi `runByClient` : envoyer `speakDeferred {turnId: "voice-readback-<uuid>", sourceTurnId}` quand `readbackAdmissible()` le permet :
   - tout de suite si le tour a été retiré (l'annonce) ;
   - à la réception de `deferredReady` sur le tour source (la réponse) ;
   - pour un tour resté courant, garder `requestDeterministicReceipt` (annonce, ou réponse si elle est déjà là), puis `speakDeferred` sur `deferredReady`.
4. Refus : retenter seulement `not_admissible`. Retirer l'entrée sur tout autre refus et sur `deferredDropped`. `readbackAnswered` sait déjà associer un tour de relecture à son entrée.
5. `VoiceV2Protocol.control` : ajouter `speakDeferred`. Copier le contrat partagé à l'identique (parité `runtime-sync --check`).
6. Garder `awaitReadback` (A1 par `runByClient`) pour `delegateToMain` / `ask_samantha` et pour un Companion qui n'annonce pas `deferredReadback`. Facultatif : remplacer le texte local « Je te l'écris dans la discussion. » de `delegateToMain` par la même annonce.

## Routes, budgets, capacités
- Aucune route HTTP nouvelle : champ optionnel `voiceTurn.deferredReadback` sur `/v1/extensions/claw-live/capability`, contrôle et évènements sur la socket voix existante. Aucune ligne `companion-acceptance.py` à ajouter (route inchangée, budget du tour inchangé : 30 s).
- Budget du suivi différé :
  - une lecture du registre des runs par seconde et par tour différé ouvert (au plus 3 par séance), pendant au plus 5 min ;
  - aucun appel Gateway par lecture pour un run observé (même lecteur `getRunStatus` que la boucle des 30 s) ;
  - aucun stockage.
- Capacité : aucune (`NO_CAPABILITY`, surface vocale owner). Le parcours de paiement et les routes déterministes ne sont pas modifiés.

## Fixtures
`openclaw-plugin-mobile-ui/fixtures/s24-2026-10-30-voice-slow-brain/` : lignes stderr du Companion et run Gateway de l'incident, nettoyés. La clé de session est raccourcie et les montants des factures sont remplacés par des montants fictifs.

## Tests (inscrits en CI, job `mobile-ui-plugin`)
- `scripts/test-voice-deferred-readback.cjs` (nouveau, 16 cas) :
  - la course S24 : réponse 0,4 s après l'échéance, annonce dite puis réponse dite une seule fois ;
  - la forme de l'incident : tour retiré à 14 s par un début de parole sans parole ;
  - réponse arrivée avant le reçu ;
  - prompt de reçu classique ;
  - nouvelle demande et « stop » qui annulent ;
  - réflexe qui n'annule pas ;
  - séance fermée ;
  - expiration à 90 s ;
  - priorité de la parole d'Amine et barge-in ;
  - app ancienne sans souscription (A1 inchangé) ;
  - texte borné et jamais fourni par l'app ;
  - contrat partagé ;
  - câblage réel du propriétaire Warm.
- `scripts/test-voice-brain-delegation.cjs` : nouvelle annonce, pas de suivi sans propriétaire.
- `scripts/test-warm-v2-ownership.cjs` : `deferredReadback` annoncé en v2, absent en v1.

## Retour arrière
Revert de ce commit, puis `companion-deploy.sh` du commit précédent. Une app qui a souscrit ne voit plus `warmReady.deferredReadback` et revient à A1.
