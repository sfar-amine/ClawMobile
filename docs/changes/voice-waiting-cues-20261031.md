# Samantha Voix : une phrase utile pendant l'attente, puis plus de remplissage (31/10/2026)

Décision d'Amine du 31/10 (« go pour tout ») après le banc voix S24 du 31/10. Pendant que le cerveau travaille (15 à 40 s aujourd'hui), l'app jouait des clips d'attente génériques et les relançait toutes les 5 à 10 s. On le voyait dans logcat : `waiting_local name=waiting-1/2`, `relaunch_local index=0`, `brain_tool_in_progress count=1`. Au-delà des 30 s du budget vocal, le Companion ajoutait « Je cherche encore, je te donne la réponse dès que je l'ai. ». Amine trouve cette répétition agaçante.

## Cible (deux lignes, une PR chacune)
- **Une seule phrase utile par tour.** Elle n'est dite que si la réponse n'est pas là après 1,5 s. Elle vient de l'outil typé que le run a lancé :
  - `samantha_utility_billing`, `samantha_steg`, `samantha_sonede`, `samantha_topnet` : « Je regarde tes factures. » ;
  - `samantha_agenda` : « Je consulte ton agenda. » ;
  - `samantha_maxit_tunisie` : « Je regarde ton compte Orange. » ;
  - `samantha_pulse` : « Je regarde dans Pulse. » ;
  - sinon : « Je m'en occupe. ».
- **Ensuite, plus aucune parole de remplissage.** Au plus un son discret toutes les 6 s, 5 signes au maximum, tous avant 30 s.
- **Au-delà de 30 s, une seule annonce** : « Je te donne la réponse dès que je l'ai. ». La réponse différée suit comme aujourd'hui (#475/#477).
- **Réglage dans l'app** : Réglages › Voix › « Annonces pendant l'attente », avec trois choix :
  - Phrase utile (par défaut) ;
  - Son discret ;
  - Silence.

  L'annonce des 30 s reste dans les trois modes : c'est une information.

## Qui dit quoi
- **L'app est le propriétaire existant de la phrase d'attente.** Ce sont ses clips locaux, dans la voix de Samantha, enregistrés une fois par une relecture mot pour mot. Elle garde ce rôle. Il n'y a ni nouveau store ni nouveau routeur.
- **Le Companion dit seulement ce que le run fait.** `brain_tool_in_progress` n'est pas un signal du Companion. C'est l'app qui répond « en cours » à un appel d'outil du modèle vocal (`ask_samantha`, `clawmobile_capability`) pendant un tour cerveau, et ce nom ne dit rien du travail réel.
- **Le seul endroit où le Companion voit l'outil typé du cerveau** est l'observateur Gateway du run (`observeGatewayRun`, trames `stream: "tool"`, `phase: "start"`, `data.name`, `data.args.action`). Jusqu'ici, il jetait les appels sans titre.

## Changement (Companion)
- **`runProgress.ts`.**
  - `typedToolActivity`, `readRunActivity` et `runActivity` donnent l'activité courante d'un run : le dernier outil typé `samantha_*` lancé et son action. Les paramètres, les arguments et les résultats n'en font jamais partie.
  - `samantha_catalogue` (découverte) n'est pas une activité.
  - Pour un run lu par son transcript (non observé), l'activité vient du dernier évènement `Calling samantha_….`, avec l'action lue dans le résumé borné des arguments.
- **`runs.ts`.**
  - L'observateur enregistre `gatewayProgress.activity` à chaque début d'appel d'outil typé, dans la même file bornée de 48 écritures. Ce n'est jamais une étape publique.
  - `readGatewayProgress` revalide le champ au rechargement du registre.
  - `withRunSteps` l'expose en `progress.activity` sur `GET /v1/runs/{id}` et sur `GET /v1/runs/by-client/{clientRunId}`. L'app lit d'abord le run par son clientRunId.
- **`voiceBrainDelegation.ts`.** L'annonce des 30 s devient « Je te donne la réponse dès que je l'ai. ». L'app a déjà dit ce qu'elle faisait, donc plus de « je cherche encore ». Elle reste dite une seule fois (`VoiceTurnProtocol`, inchangé).
- **Contrat partagé** `fixtures/protocol/voice-v2-app-companion.json` :
  - `deferredReadback.pendingNotice` change de texte ;
  - nouvelle section `waitingCues` : `progress.activity`, motifs, modes, délais et phrases.

  La copie de l'app est alignée à l'identique dans la PR app.

## Compatibilité
- **Companion nouveau, app ancienne.** L'app ignore `progress.activity` : `RunJourneyJson` ne garde que les clés connues. Elle garde ses clips d'attente, et l'annonce des 30 s prend la nouvelle formulation.
- **Companion ancien, app nouvelle.** Sans `progress.activity`, la phrase est la phrase générique « Je m'en occupe. », et l'annonce garde l'ancienne formulation.
- **Pas besoin d'annonce `warmReady`.** Le champ est facultatif, ajouté à une lecture existante. Son absence vaut « activité inconnue ». Aucun comportement ne dépend d'une souscription.

## Limite connue
Sur le S24, le cerveau ouvre sa session Gateway entre 10 et 22 s après l'acceptation du run (captures `s24-2026-10-25-gateway-observation`, `s24-2026-10-26-gateway-terminal-timing`). À 1,5 s, l'outil typé est donc rarement connu : aujourd'hui, la phrase sera le plus souvent « Je m'en occupe. ». La phrase contextuelle servira à mesure que le cerveau accélère. Le seuil reste à 1,5 s, comme décidé : on n'attend pas l'outil en silence.

La forme exacte de la trame d'outil typé sur le flux Gateway (`data.name`, `data.args.action`) est celle que l'observateur lit déjà pour `progress_card` et pour les titres. Elle reste à confirmer sur le S24 à la recette, par la ligne logcat `waiting_cue phrase=billing source=clip`. L'appel enveloppé `tool_call` de Tool Search n'est pas lu. Les outils fréquents sont « direct-only » depuis #476.

## Routes, budgets, capacités
- **Routes.** Aucune route nouvelle : champ facultatif `progress.activity` sur `GET /v1/runs/{id}` et `GET /v1/runs/by-client/{clientRunId}`. Aucune ligne `companion-acceptance.py` à ajouter (routes et budgets inchangés).
- **Budget.** Au plus une écriture par début d'appel d'outil typé, dans la file bornée existante. Aucune lecture Gateway de plus : les lectures d'un run observé restent locales, et le test le vérifie.
- **Capacité.** Aucune (`NO_CAPABILITY`, surface vocale owner). Le parcours de paiement n'est pas modifié.

## Fixtures
Captures S24 existantes, réutilisées telles quelles :
- `s24-2026-10-30-direct-call-id/direct-calls.json` : appels `samantha_agenda` et leurs actions ;
- `s24-2026-10-30-tool-search-direct/brain-run-tool-sequence.json` : séquence d'outils du run du 30/10 (read, tool_search, exec) et noms typés du S24 ;
- `s24-2026-10-25-typed-tools/compiled-agent-tools.json`.

Aucune nouvelle capture : pas d'accès S24 pour ce lot.

## Tests (inscrits en CI, job `mobile-ui-plugin`)
- `scripts/test-voice-waiting-cues.cjs` (nouveau, 5 cas) :
  - activité d'un appel typé du S24 sans ses paramètres ;
  - outils non typés et découverte exclus ;
  - activité lue depuis le transcript ;
  - observateur : lecture par id et par clientRunId, sans lecture Gateway, rechargement du registre avec un champ forgé ;
  - texte de l'annonce et contrat partagé.
- `test-voice-deferred-readback.cjs`, `test-voice-brain-delegation.cjs` : nouveau texte de l'annonce.

## Retour arrière
Revert de ce commit, puis `companion-deploy.sh` du commit précédent. L'app nouvelle retombe sur la phrase générique et l'ancienne annonce.
