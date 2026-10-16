# HS8 v2 — captures S24 du 11/10/2026 (core #138, tête `9973391b`)

Ces captures complètent `../hs8-captures/` (core #174). Décision applicable : D45-3. Gemini passe en premier sur le profil gratuit `claw-gemini-free`. En cas d'échec, l'audio est conservé et Gemini est réessayé plus tard. Pas d'OpenAI sans crédits API.

Ce sont des données seulement. Aucune configuration modifiée, aucun redémarrage, aucun déploiement. Le garde reste fermé.

| Fichier | Verdict |
|---|---|
| `sdk-installed-resolution.json` | **OK sans NODE_PATH.** Le résolveur de #138 (branche `npm root -g`) charge les trois exports SDK 2026.9.6 dans le contexte exact du Companion installé. Import à froid : 2,7 à 3,6 s. Avec `NODE_PATH`, la branche locale charge le même paquet. #138 n'est **pas déployé** sur le S24 (runtime `5631fe9`). |
| `gemini-free-profile.json` | **Profil OK, mais Gemini écarté.** Le profil `google:claw-gemini-free` est en `api-key` (verrouillé, et aussi choisi par défaut par le SDK). `models.providers.google.apiKey` est une SecretRef `store` qui pointe vers une **autre** clé. Résultat : `primaryBlocked` = true dans #138. |
| `android-memo.json` | **Bloqué : permission micro.** L'app n'a pas d'enregistreur de mémo. Termux:API n'a pas `RECORD_AUDIO`. Marque ftyp réelle non capturée : MediaRecorder AOSP devrait écrire `mp42`/`isom`, que `isM4aContainer` **refuserait**. La transcription Gemini par le code #138 réussit sur le M4A existant : « Bonjour, Samantha. », 1,5 s. |
| `chatgpt-subscription-audio-probe.json` | Sonde D45-3 nettoyée. Le backend de l'abonnement refuse l'audio (deux erreurs 400). L'API de transcription répond 429 `insufficient_quota`. |
| `deferred-retry-owner.json` | Le propriétaire du « nouvel essai plus tard » est le registre des runs (`runs.ts`, `StoredRun.memo`), avec un rapprochement paresseux à la lecture du statut. Aucun nouveau store ni scheduler. |

## Méthode

- Le code de #138 est compilé avec `tsc` depuis `9973391b`. Les SHA256 des sources sont dans le JSON.
- Il est exécuté sur le S24 avec le binaire, le cwd et l'environnement du process Companion. La résolution passe par `createRequire(dist/companion/server.js)`.
- Les fichiers ont transité par une branche temporaire, supprimée ensuite. Le dossier `~/.cache/tmp/hs8` a été supprimé du S24.
- Les reçus Claw `mcp-claude-chat-hs8v2-*` sont cités dans chaque JSON.
- Pas de nouveau mémo audio versionné : aucun enregistrement Android n'a été possible.

## Reste à faire pour activer HS8

1. **Enregistrement micro sur le S24** : Amine décide d'accorder `RECORD_AUDIO` à Termux:API, ou Codex livre un enregistreur de mémo dans l'app. Ensuite, capture de la marque ftyp réelle.
2. **Contrôle du conteneur dans #138** : accepter `mp42`/`isom` avec une piste audio, et pas seulement `M4A `.
3. **`primaryBlocked`** : retirer ou aligner `models.providers.google.apiKey` (édition de config par Claude, après décision), ou bien ne plus bloquer quand le profil est verrouillé.
4. **`tools.media.models`** est vide sur disque. Il faut y ajouter l'entrée Google audio. #138 propose `gemini-3-flash-preview`, mais seul `gemini-3.5-flash-lite` est qualifié ici. `memoAudioConfig` exige encore une entrée OpenAI, ce qui est à réaligner sur D45-3.
5. **Repli D45-3 « nouvel essai Gemini plus tard »** : à implémenter dans le registre des runs (voir `deferred-retry-owner.json`).
6. **Déploiement** de #138 une fois fusionné. `NODE_PATH` reste facultatif.
