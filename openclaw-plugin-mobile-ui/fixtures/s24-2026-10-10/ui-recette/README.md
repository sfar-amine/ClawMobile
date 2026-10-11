# Captures S24 — recette UI serveur du 10/10/2026

Capturées par Claude le 10/10/2026 entre 19:20 et 19:40 UTC sur le S24 (Termux), Companion déployé `9cdd84f`, OpenClaw `2026.9.6`. **Lecture seule** : `curl` loopback `http://127.0.0.1:8765/v1`, `timeout 60 nice openclaw gateway call <méthode> --params <json> --json`, et SQLite ouvert en `?mode=ro`. Aucune écriture, aucun redémarrage. Le nettoyage a été fait sur le téléphone avant que les données en sortent.

## Fichiers
- `gateway.*.json` : réponses Gateway lues par le Companion, au format `{_capture, response}`.
  - `config.get` : extrait (R6/R11).
  - `models.list {agentId:main, includeDetails:true}`.
  - `models.authStatus {agentId:main}`.
  - `sessions.list {limit:1}` : pour les `defaults`.
  - `sessions.list {search:"companion-", limit:100}` : 4 lignes gardées sur 31.
  - `usage.status`.
  - `usage.cost {days:30}` : cache `fresh`, 3 jours gardés sur 30.
- `companion.*.json` : réponses du Companion **avant correction**, avec les défauts de la recette.
  - `agent-config` : e-mail du compte dans `model`, gpt-5.6-sol réduit à « off ».
  - `usage` et `providers` : dates en epoch ms.
  - `updates` : version `0.1.0` sans commit.
  - `control-engineering` et `control-automations` : produits par samantha-ui-playbooks.
  - `conversations` : aperçus en JSON brut.
  - `metadata-decision-stale` (sélecteur désactivé) et `metadata-decision-fresh`.
  - `metadata-historical` : 404 sur une conversation listée.
- `measures.json` : latences mesurées, balayage e-mail de toutes les routes de lecture, diagnostic du coût et des conversations historiques.

## Nettoyage
- Profils d'authentification : un profil e-mail devient `<fournisseur>:owner@example.invalid`, les autres deviennent `<fournisseur>:profile-N`. Les références de modèle `…@<profil>` suivent la même règle.
- Le `hash` de `config.get` est remplacé, au format `hmac-sha256:` conservé.
- Textes libres (titres, noms, aperçus) : `<texte N car.>`. Aperçus JSON : structure conservée, chaque valeur texte devient `<vN>`.
- Suites de chiffres et numéros : `+21600000000`.
- Montants (`*Cost`, `costUsd`) : remplacés par `1.25`. Les compteurs de tokens réels sont conservés.
- Clés de session `companion-chat-*` et `sessionId` : hachés, sauf `decision-v2-live-5a66bfd3a1`, qui est une session de test.
- Champs de compte de `usage.status` (`account*`, `email`) : supprimés.
- Vérification finale : aucune adresse sauf `owner@example.invalid`, aucun `+216` réel, aucun `sk-`, `Bearer`, `apiKey`, `access_token` ou `refresh_token`.

## Constats qui fondent les corrections
1. **Fuite d'e-mail.** `/agent/config` publiait `openai/gpt-5.6-sol@openai:<e-mail>`. Aucune autre route de lecture de `companion-acceptance.py` ne renvoie d'adresse : la recette peut donc refuser tout e-mail.
2. **Coût toujours « computing ».** `usage.cost` de la Gateway rafraîchit son cache en arrière-plan (environ 4 s mesurées) mais garde une réponse `refreshing` en cache pendant 30 s. Le Companion figeait `computing` pendant 10 min. Sur un téléphone actif, chaque nouvelle lecture retombait sur des fichiers périmés.
3. **Sélecteur de modèle.** `modelChangeAvailable:false` venait seulement de `conversation_model_catalog_stale` : l'instantané propriétaire avait plus de 60 s et la route ne le relançait pas. Juste après une lecture `/agent/config`, la même conversation renvoyait `true`.
4. **Conversations historiques.** 8 conversations listées sur 10 n'ont plus de session côté Gateway : aucune ligne `session_nodes`, recherche exacte `sessions.list` vide. La clé utilisée par la liste et par la route est la même. Il n'y a donc pas de défaut de correspondance, et le 404 est exact au sens de la Gateway.
5. **Niveaux de réflexion.** `models.list` ne donne aucun niveau pour gpt-5.6-sol. `sessions.list.defaults` en donne 8 (`off` à `ultra`, défaut `low`), et c'est la source de R18.
