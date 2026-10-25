# Samantha Voix v2 : avancement dit pendant un tour cerveau (25/10/2026)

Suite de [voice-v2-reflexes-progress-20261025](voice-v2-reflexes-progress-20261025.md). Décision d'Amine du 25/10 à 09:44 : « le live avancement m'intéresse beaucoup aussi pour les étapes de progression ». Les phrases viennent de la carte de progression de l'agent, rédigée pour Amine (son sujet, jamais le mécanisme), selon la règle canonique des playbooks (`user-progress-rule-20261025`).

## Changement (Companion, protocole voix v2)
- **Nouveau contrôle `speakProgress`** (`voiceTurnProtocol.ts`), champs `operationId`, `sessionEpoch`, `turnId`, `text`.
  - La phrase est lue mot pour mot (même consigne que les relectures), sur le **même tour**, comme une nouvelle génération `out-<tour>-progress-<n>`.
  - Admise seulement si ce tour possède la sortie, que sa génération précédente est finie, que son exécution Companion est en cours (résultat absent) et que personne ne parle.
  - Bornes : 200 caractères, 6 phrases par tour.
  - Sinon : `warmAck` `refused` et événement `progressRefused {reason}` pour ce tour (`invalid_text`, `progress_budget`, `not_admissible`). Jamais d'erreur de session : un avancement manqué ne coupe pas l'appel.
  - Une nouvelle parole d'Amine interrompt la phrase en cours comme toute sortie ; le tour interrompu ne parle plus.
- **Aucune seconde exécution.** Un appel d'outil du modèle vocal pendant une phrase d'avancement est refusé au fournisseur (`progress_readback`), jamais exposé à l'app.
- **Lecture du reçu inchangée.** `receiptReply` attend la fin de la dernière phrase d'avancement (`output_open` sinon), puis lit le reçu comme avant.
- **Annonce.** `warmReady` v2 porte `progressReadback: 1` ; une app ancienne ne l'envoie jamais (`clawLiveWarm.ts`).
- **Mesure.** La métrique `t30p` d'une phrase d'avancement est marquée `phase: 2`, sans `gemini_ms` ni `response_ms`, pour ne pas fausser le temps de réponse du tour.
- **Contrat partagé app/Companion** (`fixtures/protocol/voice-v2-app-companion.json`) : `speakProgress`, ses bornes, ses raisons de refus et `optionalWarmReadyFields.progressReadback`. La copie de l'app sera mise à jour à l'identique par le lot APK.

## Routes, budgets, capacités
- Aucune route HTTP nouvelle ni modifiée : contrôle sur la socket voix existante (`/v1/extensions/claw-live/warm`). Pas de ligne `companion-acceptance.py` à ajouter.
- Budget : aucun appel Gateway, aucun stockage ; une phrase = un message au fournisseur vocal.
- Capacité : aucune (`NO_CAPABILITY`, surface vocale owner). Paiement et routes déterministes inchangés.

## Tests (inscrits en CI, job `mobile-ui-plugin`)
- `scripts/test-voice-turn-protocol.cjs` : 7 nouveaux cas (37 au total). Cas admis ; refus sans exécution, résultat déjà là, sortie encore ouverte, salutation, relecture, tour interrompu, Amine qui parle ; texte vide ou de plus de 200 caractères ; plus de 6 ; outil refusé pendant la phrase ; `receiptReply` après la fin de l'avancement ; interruption par une nouvelle parole ; mesure en phase distincte.
- `scripts/test-warm-v2-ownership.cjs` : `progressReadback` annoncé en v2, absent en v1.

## Retour arrière
Revert de ce commit puis `companion-deploy.sh` du commit précédent. L'app ne voit plus `progressReadback` et n'envoie plus d'avancement.
