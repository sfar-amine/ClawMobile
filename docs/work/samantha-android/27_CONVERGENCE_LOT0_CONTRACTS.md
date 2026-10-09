# Convergence Samantha / ClawMobile — Phase 0 : contrats gelés (v1)

Statut : gelé 2026-10-09 par Claude, relecture ChatGPT attendue. Toute modification passe par une nouvelle version de ce fichier (v2…), jamais par une divergence silencieuse.
Référence S24 : décision split Claude/ChatGPT (event 58de3ecf…), plan EVT-1682.

## C1 — Télémétrie Voice `samantha.voice.telemetry.v1`

Une ligne JSON par événement, sans audio ni transcript :

```json
{"schema":"samantha.voice.telemetry.v1","src":"app|companion","sid":"<duplexSessionEpoch>","turn":3,"ev":"t21","boot_ns":123456789,"wall_ms":1791540000000,"x":{}}
```

- Horloge unique : `boot_ns` = CLOCK_BOOTTIME. App : `SystemClock.elapsedRealtimeNanos()`. Companion (même S24) : `time.clock_gettime_ns(time.CLOCK_BOOTTIME)`. Aucune synchronisation inter-appareils nécessaire.
- App : `Log.i("SamanthaVoiceT", json)`, export `adb logcat -s SamanthaVoiceT -v raw`. Companion : append JSONL `~/.openclaw/telemetry/voice/<date>.jsonl`. Pas de nouveau store.
- `x` : champs techniques bornés (codes, tailles, états). Interdit : texte, audio, token, credential.

| Code | Événement | Émetteur |
|---|---|---|
| t00 | voice_request (tap) | app |
| t01 | prewarm_requested | companion |
| t02 | token_helper_start | companion |
| t03 | token_ready | companion |
| t04 | websocket_start (provider) | companion |
| t05 | websocket_open (provider) | companion |
| t06 | setup_sent | companion |
| t07 | setup_complete / warm_ready émis | companion |
| t07c | warmReady reçu | app |
| t10 | audio_record_start_requested | app |
| t11 | microphone_ready (premier read OK) | app |
| t21 | local_speech_detected (Silero Start) | app |
| t22 | activity_start envoyé | app |
| t24 | local_end_detected | app |
| t25 | activity_end envoyé | app |
| t25p | activity_end relayé provider | companion |
| t30p | premier audio provider reçu | companion |
| t30 | premier audio reçu par l'app | app |
| t31 | premier write AudioTrack | app |
| t32 | premier frame joué (AudioTrack.getTimestamp / playbackHead > 0) | app |
| t41 | silero_event_start pendant Speaking | app |
| t42 | stop_playback_called | app |
| t43 | pause/flush retourné | app |
| t44 | provider_interruption_confirmed | companion + app |
| t50 | voice_close | app |
| t51 | audio_resources_released | app |

Références externes (non émises par le device) : t20 début réel de parole, t23 fin réelle, t40 onset d'interruption. Mesurées sur l'enregistrement externe unique ; alignement sur l'horloge device via l'onset audible de la réponse ↔ t32 (et, en contrôle, l'arrêt audible ↔ t43).

KPI : `T_response = t32 − t23` (n°1) ; `BargeDetect = t41 − t40` ; `BargeCut = t43 − t41` ; `BargeE2E = t43 − t40`.

## C2 — Feature flags Voice (A/B sans rebuild)

- Présents en `debug` et `benchmark*`, absents de `release`.
- Écriture : `adb shell am broadcast -a ai.samantha.android.VOICE_LAB -n <pkg>/ai.samantha.android.VoiceLabReceiver --es <clé> <valeur>` ; récepteur protégé par `android.permission.DUMP` (détenue par shell).
- Lus à chaque `start()` Voice ; jamais pendant une session. Chaque événement t00 porte les flags actifs dans `x.flags`.

| Clé | Valeurs | Défaut = comportement 0.10.1 |
|---|---|---|
| voice.ns | off, on | off |
| voice.endpointing | silero, provider | silero |
| voice.silero.min_speech_frames | 1–6 | 3 |
| voice.bargein | on, off | on |
| voice.telemetry | on, off | on (debug/benchmark) |

## C3 — Corpus Voice `samantha.voice.corpus.v1` (propriété ChatGPT)

JSONL, un cas par ligne :

```json
{"id":"guard-es-que-noise","cat":"guard_reject","lang":"es","stimulus":"bruit court transcrit ¿Qué?","expect":"reject","origin":"REQ-1652"}
```

`cat` ∈ silence, noise_short, noise_continuous, background_speech, speaker_echo, bargein_true, bargein_false, short_word, lang_fr, lang_en, lang_ar, lang_tn, mixed, named_entity, foreign_script, guard_reject, network, late_receipt, action_capability. `expect` ∈ accept, reject, interrupt, no_interrupt, respond, no_effect.
Le cas REQ-1652 est obligatoire et doit rester `reject`.

## C4 — Sous-ensemble /v1 consommé par l'app (propriété ChatGPT côté serveur)

`/v1/health`, `/v1/capabilities`, `/v1/runs`, `/v1/runs/{id}`, `/v1/runs/by-client/{clientRunId}`, `/v1/skills`, `/v1/extensions/claw-live/*` (dont `socket` protocol=2, messages `warmReady`, `warmError`, `warmControl`), `/v1/extensions/samantha-control/*`.
Toute rupture de schéma de ces routes exige une version de contrat et un test côté app avant merge.

## C5 — Propriété et coordination

| Périmètre | Écrivain | Branche / emplacement |
|---|---|---|
| App Android Samantha | Claude | `feature/samantha-lot0-app-20261009` (worktree `~/.openclaw/worktrees/samantha-lot0-app-20261009`), base `4a5fdc6` |
| Runtime Companion /v1, relay claw-live, token helper | ChatGPT | branche `runtime/samantha-companion-private` ou dérivée |
| Corpus, scripts d'analyse, protocole séances | ChatGPT | à déclarer dans S24 |
| Contrats (ce fichier) | Claude, relu ChatGPT | branche app |

- App et runtime partagent le dépôt ClawMobile : ne jamais écrire sur la branche de l'autre.
- Accès physique S24 (UI/ADB/install APK) : exclusif ; déclaré par événement S24 `checkpoint` avant usage et libéré après.
- Avant chaque séance : `claw_context`, intégration des deltas de l'autre surface.
- Merge points : M1 baseline (RDV1), M2 A/B (RDV2), M3 recette finale / bascule (RDV3). Aucun merge sans les checkpoints valides des deux surfaces.

## C12 — R1 : composants santé en défaut (Contrôle v2)

Lecture additive sur `/v1/extensions/samantha-control/health?contract=2` et snapshot v2 avec `sections=health`. La façade Companion complète `sections.health.data.components` depuis le verdict canonique Health Manager `~/.openclaw/health/current.json`. Aucun probe, réparation, store, registry ou scheduler supplémentaire. Le contrat v1 reste inchangé.

Chaque composant non sain du verdict est exposé une seule fois avec son `id` canonique, `status`, `checkedAt`, `label: {fr, en}`, `name` compatible et une `description` courte masquée. Les composants historiques sont conservés ; un composant historique déjà présent reçoit le verdict courant. Les identifiants inconnus utilisent leur id stable comme libellé, sans texte source arbitraire. Les états non reconnus restent `unknown`.

`control_plane.maintenance` : libellés « Maintenance du système » / « System maintenance » ; motif `daily_log_audit` visible lorsqu'il figure dans le verdict. Aucun champ `evidence`, secret ou payload brut du verdict n'est transféré.

Un verdict absent, invalide, futur ou âgé de plus de 300 s ne prouve pas la santé : `fresh=false`, `status=unknown`, fraîcheur d'enveloppe `stale` et durée restante nulle. La révision couvre aussi la projection enrichie ; `knownRevision` ne masque pas une nouvelle panne ou un nouveau motif.

Tests : `node scripts/test-control-health-components.cjs` (projection, déduplication, FR/EN, masquage, états, expiration, révision et HTTP health/snapshot/knownRevision). Build et trace-induction obligatoires.

Livraison Git uniquement. Reçu S24, intégration, recette et activation à produire par Claude après relecture ; aucun reçu live n'est revendiqué par ce lot.
