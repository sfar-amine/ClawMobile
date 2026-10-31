# Voix : étapes de latence côté Companion — 31 octobre 2026

Banc voix du 31/10 sur le S24 (core 446945af, `SAMANTHA_BRAIN_ONLY=1`), télémétrie de l'app, fin de parole (t25) → premier audio de réponse (t30) :
- « merci Samantha » : 6,2 s, sans outil ;
- « quelle heure est-il » : 12,0 s, un outil pour l'heure ;
- agenda de demain : 13,1 s, un appel typé.

Aucune étape côté Companion n'était persistée : `telemetry/voice/*.jsonl` est le producteur de laboratoire (`CLAW_VOICE_TELEMETRY=1`), arrêté depuis le 10/10. Les 6 s fixes d'un tour sans outil n'étaient donc pas décomposables.

## Changement

Une ligne par tour vocal, au premier audio de la réponse (phase reçu), toujours active :

```
[voice-stages] run=<runId> stt_final_ms=… first_audio_ms=… capability_ms=… accepted_ms=… sent_ms=… run_start_ms=… first_tool_ms=… first_text_ms=… terminal_ms=… settled_ms=… capability_done_ms=… receipt_ms=… audio_ms=… tools=…
```

Chaque valeur est un écart en millisecondes depuis la fin de parole (`turnEnd`, t25 de l'app) ; `-` = non observé, jamais un zéro inventé. Aucune demande, réponse, nom d'outil ni argument.

| Étape | Propriétaire de la marque |
| --- | --- |
| `stt_final` : transcription finale reçue | protocole de tour vocal (`transcriptFinal`) |
| `first_audio` : premier audio du tour (phrase d'attente ou réflexe) | protocole de tour vocal |
| `capability` / `capability_done` : exécution `/claw-live/capability` admise puis rendue | protocole de tour vocal (`measureCapability`) |
| `accepted` : run du cerveau réservé | registre des runs (`acceptedAt`) |
| `sent` : requête `agent` envoyée au Gateway | observation Gateway (`requestSentAt`, existant) |
| `run_start` : début du run (événement `lifecycle` `start`) | observation Gateway, nouveau |
| `first_tool` / `tools` : premier départ d'outil, nombre de départs | observation Gateway, nouveau |
| `first_text` : premier delta de texte de l'assistant | observation Gateway, nouveau |
| `terminal` / `settled` : RPC terminal reçu, écriture du règlement | observation Gateway (existant) |
| `receipt` : reçu remis au modèle vocal | protocole de tour vocal (`receiptRequestedAt`) |
| `audio` : premier audio du reçu transmis à l'app | protocole de tour vocal (t30p phase 1) |

- Les nouvelles marques du run (`runStartedAt`, `firstToolAt`, `firstTextAt`, `toolStarts`) sont gardées en mémoire pendant le suivi. Elles sont écrites dans `gatewayObservation.timing` par l'écriture terminale existante, jamais par une écriture de plus, et le lecteur borné les filtre (clés fermées).
- Le propriétaire Warm garde les 8 derniers enregistrements dans `GET /claw-live/warm-status` (`voiceStages`), sans nouvelle route.
- La ligne passe par le journal borné du Companion (`bounded-log.py` gère la rotation).
- Une erreur d'instrumentation est ignorée : le tour n'est jamais modifié.

Lecture sur le S24 : `grep '\[voice-stages\]'` dans le journal du Companion, puis jointure par `run=` avec `transcript_events`.

## Test

`scripts/test-voice-turn-stages.cjs` rejoue le tour vocal réel du S24 du 25/10 (`fixtures/s24-2026-10-25-gateway-observation/native-timing.json`, run_1792934450703) à travers les propriétaires exacts. L'enregistrement redonne la décomposition capturée :
- 941 ms jusqu'à la phrase d'attente ;
- 4 603 ms jusqu'à l'acceptation du run ;
- 21 798 ms de préparation Gateway ;
- 54 158 ms jusqu'au premier audio utile.

Le test vérifie aussi :
- aucun texte dans la ligne ni dans le statut ;
- aucune écriture du registre pour les événements `lifecycle` et `assistant` ;
- la persistance par l'écriture terminale ;
- le comptage borné des outils ;
- un lecteur ou un journal en panne sans effet sur le tour.

## Retour arrière

Revert du commit. La ligne et le champ `voiceStages` disparaissent. Les marques déjà écrites restent lisibles : l'ancien lecteur les ignore.
