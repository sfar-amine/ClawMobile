# Voix en direct indisponible (17/10/2026) — tour d'accueil refusé en 400

Captures nettoyées du S24 (aucun texte de conversation, aucun identifiant de session de l'app) :
- `capture.json` : lignes logcat `SamanthaVoice` (chaque ouverture de la feuille voix échoue en `warm_start_failure:runtime_http_400`),
  état du Live côté Companion (prewarm et WebSocket `protocol=2` : `warmReady`, fermeture 1000),
  et rejeu de `saveVoiceTurn` (runtime 8f739885) sur une copie du registre : `voice-greeting-<uuid>` → 400 `invalid_voice_transcript`.

Utilisée par `scripts/test-voice-greeting-turn.cjs`.
