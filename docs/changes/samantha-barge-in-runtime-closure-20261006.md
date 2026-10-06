# Samantha barge-in runtime — clôture privée — 6 octobre 2026

Le Companion privé actif est publié sur `runtime/samantha-companion-private` commit `8cc7a08dcfaa2969bebedb03bbe9f9d909c929a6` et son build est chargé par le service supervisé.

Le Warm Core v2 expose le profil barge-in actif uniquement pour la route intégrée du S24, modèle `gemini-3.8-live`, avec frontière de transcription `android_speech_service`. Les transcriptions Gemini restent informatives ; elles n'autorisent jamais une action. La transcription finale Android corrélée au turnId est requise avant décision/exécution. Les appels déjà admis restent idempotents et leurs reçus tardifs ne débloquent pas un nouveau tour.

Tests : TypeScript build OK, 14 scénarios de protocole OK, ownership Warm v2 OK, régressions Warm OK. Sur le process Companion actif, Companion, ADB et Gateway sont online ; le prewarm retourne `warm/ready`, providerReady=true, protocolVersion=2, bargeIn.enabled=true et la frontière `android_speech_service`.

Retour arrière : restaurer le `dist` sauvegardé, remettre le commit privé précédent et désactiver `voiceBargeIn.enabled`. Aucun nouveau service, scheduler, routeur ou store n'a été ajouté.
