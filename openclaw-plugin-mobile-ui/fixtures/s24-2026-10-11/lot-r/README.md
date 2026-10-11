# Captures S24 du 11/10/2026 : lot R, lexique et budget `/agent/config`

Ces captures ont été faites par Claude sur le S24, en lecture seule, le 11/10/2026 entre 12:34 et 12:40 (heure de Tunis). Elles répondent à la demande Codex n° 42, items 3, 4 et 7.

| Élément | Valeur |
|---|---|
| Accès | Connecteur MCP Claw, `claw_exec`, profil `chat-owner`, clés `cl-lotr-20261011-*`, `cl-lex-20261011-*`, `cl-r7-20261011-*` |
| OpenClaw | `2026.9.6 (eb377ac)` |
| Runtime core (`~/ClawMobile`) | `3298d98d8a29458abda6617c37ca5e4b114f4be2` (`runtime/samantha-companion-private`) |
| Reçu de déploiement | `~/.openclaw/deploys/companion-20261011T121900.json` (`target` 3298d98d, `previous` 363a6b8e) |
| Révision des capabilities | `90a0c68e6ea5838f` |

## Fichiers

| Fichier | Contenu | Source |
|---|---|---|
| `config-projection.json` | Chaînes de modèles (defaults, main, engineering-lite, gemini), `modelPolicy.allow`, Terra, formes Gemini, talk (temps réel et lecture à voix haute), compaction, recherche mémoire, état d'authentification, Copilot, verdict de santé | `openclaw gateway call config.get / models.list / models.authStatus --json`, et `~/.openclaw/health/current.json` |
| `v1-providers.json` | Forme de `GET /v1/providers`, avec statut, durée et lignes | Companion en loopback |
| `agent-config-budget.json` | `GET /v1/agent/config` : premier appel, appels chauds, 12 lecteurs concurrents, puis 3 nouvelles mesures | Companion en loopback, avant #167 |
| `../lexicon/decisions-resolve-only.json` | Décisions sur 3 énoncés du lexique (playbooks #90) | `POST /v1/extensions/claw-live/decision` (`execute:false`, donc `claw-capability.py resolve`) |

## Ce qui n'a pas été fait

- Aucune modification de configuration, aucun redémarrage, aucun déploiement.
- Aucun paiement, aucune commande Maxit, aucun message WhatsApp, aucun tour de modèle.
- Les énoncés du lexique sont seulement résolus. La route `decision` appelle `capabilityBridge` avec `execute:false` : c'est vérifié dans `server.ts`, lignes 817 à 823, au SHA déployé.

Les écritures se limitent à `~/.cache/tmp/lotr-20261011/`, un dossier de travail jetable en mode 700. Ce dossier a été supprimé après la projection (12:41) : aucun brut n'est conservé. Seules les projections nettoyées sont publiées ici.

## Nettoyage

- **E-mails de compte** : remplacés par `<compte-masque>`. Les poignées `acct-…` de `/agent/config` deviennent `acct-<handle>`.
- **Données sensibles** : aucune clé, aucun jeton, aucun cookie, aucun OTP, aucun numéro.
- **Recherche avant publication** : motifs e-mail, `AIza`, `sk-`, `ghp_`/`gho_` et numéros de 8 chiffres ou plus. Seuls des horodatages ressortent.

## Constats (signalés, rien corrigé)

1. **Terra n'est pas autorisée pour `main`.** Elle figure dans la chaîne de `main` (Sol → Terra → Luna → Gemini gratuit) et dans `models`. En revanche, `main.modelPolicy.allow` ne contient que `sol, luna, gemini-3.5-flash-lite, github-copilot/*`.
   - `models.list` (main, et aussi sans `agentId`) ne liste pas Terra : les tags passent de `default` à `fallback#2`.
   - Même chose pour `engineering-lite`. Seul `agents.defaults.modelPolicy.allow` contient Terra.
   - `/agent/config` publie pourtant Terra dans `fallbacks`.
2. **Gemini a deux formes.** On trouve une forme épinglée sur un profil, `google/gemini-3.5-flash-lite@google:claw-gemini-free` (dans les chaînes), et une forme nue, `google/gemini-3.5-flash-lite` (dans `allow` et `models`). `models.list` ne crée pas de doublon. Les valeurs par défaut n'ont pas de Gemini.
3. **Copilot est connecté mais inutilisé.** `authStatus` donne `static` et `providerOutcome` donne `ready`. `main` autorise `github-copilot/*`. Pourtant, aucun modèle Copilot n'apparaît dans une chaîne, dans `models` ou dans `models.list`.
4. **Talk.**
   - Temps réel : `google`, voix `Aoede`, `gateway-relay`. **Aucun `model` dans la config** ; le plugin mobile déclare `voiceBargeIn.protocolModel = gemini-3.8-live`.
   - Lecture à voix haute : `talk.providers.microsoft`, voix `fr-FR-DeniseNeural`.
5. **Compaction** : `openai/gpt-5.6-luna`.
6. **Recherche mémoire** : chemin `memory.search` (`enabled`, `provider: gemini`), **sans modèle**. `agents.defaults.memorySearch` est absent.
7. **`/v1/providers` répond en 5,59 s**, soit 93 % de son budget de 6 s. Ses 3 providers sont tous `unknown`, et `updatedAt` a 16 minutes d'âge, alors que l'authentification est `ok` ou `static`.
8. **`/v1/agent/config` dépasse son budget de 9 s à chaque appel** :
   - 2 réponses 200, à 9,2 et 9,8 s ;
   - 16 réponses 503 (`agent_config_unavailable`) vers 10 s, ce qui correspond à l'échéance interne de `readModelOwnerFresh` ;
   - les 12 lecteurs concurrents ont tous reçu 503.

   En CLI, `models.authStatus` prend à lui seul 9,8 s. La charge était forte (load average de 13). La mesure après #167 attend son déploiement.
9. **Système immunitaire** : il n'est pas exposé par `config.get`. Le verdict de `health/current.json` est `degraded` ; les 6 capabilities `immune.*` sont `healthy`. Les composants non sains sont `control_plane.maintenance`, `notification.whatsapp` et `transactions.runtime`.
10. **Lexique.**
    - La route `decision` n'expose aucun champ de langue.
    - Pour « 9addech batterie », la décision `device.assistance` est juste, mais sa confiance (0,187) vient d'un `skill_plan` résiduel qui vise `steg` / `billing.unpaid`.
