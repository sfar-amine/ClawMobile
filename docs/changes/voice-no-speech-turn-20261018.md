# Voix live : un tour sans parole ne coupe plus la séance (18/10/2026)

## Problème
Recette d'Amine sur le S24, le 18/10 à 12:35 : « The exchange was cut short ».

Trace S24 (`claw-trace`, logcat) :
- 12:35:45 : la demande « solde orange » part ;
- 12:35:56 : le dialogue passe en `AWAITING_CHOICE` (question de précision) ;
- 12:35:56.7 : la détection d'activité vocale ouvre un nouveau tour sur un bruit ou un écho ;
- 0,6 s plus tard, le reconnaisseur local répond `NO_SPEECH_DETECTED`, et l'app conclut `voice_fail:voice_error_exchange_cut:local_asr_failed`.

Côté relais, aucun moyen de clore un tour sans transcription : `transcriptFinal` exige un texte non vide. Le tour suivant aurait donc attendu indéfiniment la fin de cette transcription.

## Changement
- `voiceTurnProtocol.ts` : `transcriptFinal` accepte `noSpeech: true`, avec un texte vide uniquement.
  - Le tour est clos comme entrée vide et marqué interrompu.
  - Il ne peut jamais s'exécuter, aucun outil retenu n'est publié, et l'événement `inputFinal` porte `noSpeech: true`.
  - Le tour suivant est admis normalement.
  - Un texte vide sans le drapeau, ou le drapeau avec du texte, reste une erreur de protocole.
- `fixtures/protocol/voice-v2-app-companion.json` : `optionalControlFields.transcriptFinal = ["noSpeech"]`. La copie côté app suit dans la PR app jumelle.
- `scripts/test-voice-turn-protocol.cjs` : deux tests.
  - Un tour silencieux clôt l'entrée, ne publie pas l'outil retenu, refuse toute exécution et laisse admettre le tour suivant.
  - Le drapeau est obligatoire pour un texte vide, et interdit avec du texte.

## Activation
Déploiement Companion (`companion-deploy.sh`), puis installation de l'APK jumeau (la PR app envoie `noSpeech` et rejette le tour en silence), puis recette voix live d'Amine.

Retour arrière : revert, et l'ancien comportement revient (un tour silencieux coupe la séance).
