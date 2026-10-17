# Provenance lot R

Fichiers lot-r copiés à l’identique de la PR core #170, SHA `a75955f8bc21f84984a1df9c10f1afaf2d8ad87a`. La PR source ouverte n’est pas fusionnée ici. Les autres dossiers de la vague ci-dessous ne sont pas recopiés par ce lot.

## Vague 6 : captures pour Codex (11/10, 10:46-10:58Z), en lecture seule

Dossiers `lot-r/`, `lexique/`, `agent-config/`, `j1/`, `hs8/` et `hs2-badges/`. Ils répondent à la demande de Codex du 11/10 (points 1, 3, 4, 5, 6 et 7). Les points 2 (P1) et 8 ne sont pas traités ici.

| Élément | Valeur |
|---|---|
| Accès | Connecteur MCP Claw, `claw_exec` / `claw_resolve`, profil `chat-owner`, clés d'action `cap1011-*` |
| OpenClaw | `2026.9.6 (eb377ac)` |
| Runtime core (`~/ClawMobile` HEAD) | `363a6b8ef08cd95905c1264ce4b4feee928185e4` (`runtime/samantha-companion-private`) |
| Playbooks épinglés (`runtime-ui-playbooks/current`) | `c7f3e7939591a6637149d7f026761de11e9ace20` (espace de travail à la même HEAD) |
| Charge pendant la capture | load average 5,7 à 7,0, ~2,3 Go disponibles ; un paiement réel était en recette avec Amine |

### Ce qui n'a pas été fait

- Aucun paiement, aucune quote, aucun `claw_execute`, aucun appel `/command` Maxit, aucune consultation opérateur, aucune bascule réseau.
- Aucun redémarrage, déploiement, épinglage ni écriture de config ou de `runs.json`.
- Aucun appel de modèle ni de fournisseur de transcription. Aucun mémo vocal enregistré : **l'enregistrement du mémo neutre et les essais réels Gemini/OpenAI (HS8) se feront avec Amine.**
- Les seules écritures ont eu lieu dans `$PREFIX/tmp/cap1011/` (0700), supprimé à la fin.

### Commandes

- **lot-r** : `openclaw gateway call config.get|models.list|models.authStatus --json` (script détaché, 3 s d'écart) ; `curl` loopback `GET /v1/providers` et `GET /v1/agent/config` ; lecture de `~/.openclaw/health/current.json` (écrit par `health-verdict.py`). La config est **projetée** sur les seuls chemins demandés, pas recopiée.
- **lexique** : trois `claw_resolve` (résolution seule).
- **agent-config** : un GET froid, trois GET chauds espacés de 4 s, puis deux vagues de 12 GET simultanés (70 s puis 3 s après), et un GET de contrôle 7 min plus tard. Les durées Gateway viennent des lignes `⇄ res` du journal `$PREFIX/tmp/openclaw/openclaw-2026-10-11.log` (noms de méthode et durées seulement).
- **j1** : `workspace-secret-scan.py` déployé, avec les 8 racines exactes du job `samantha:nightly-acceptance` (`state/openclaw.sqlite`, table `cron_jobs`), sous `nice -n 10` ; agrégation sur le téléphone.
- **hs8** : projection `tools.media` ; `require.resolve` des sous-chemins `openclaw/plugin-sdk/*` depuis le dossier du Companion, recherche de noms dans le paquet global. Aucun import du SDK.
- **hs2-badges** : lecture du code playbooks `c7f3e79` puis des fichiers `~/.openclaw/billing/`, `~/.openclaw/telecom/runs.jsonl`, `~/.openclaw/remote-bridge/requests/` et `~/.openclaw/skill-intelligence/route-health.json` : noms de champs, types, énumérations, décomptes et âges.

### Nettoyage

- Profil OAuth OpenAI remplacé par `owner@example.invalid` (même convention que `s24-2026-10-10/gateway`). Comptes du sélecteur laissés sous la forme opaque `acct-…` servie par la route.
- Clés : présence seulement. Instructions realtime : longueur seulement. Expirations : libellé seulement.
- J1 : aucune valeur, aucun extrait, aucun numéro de ligne, aucune empreinte de valeur ; seuls types, racines, zones et chemins de fichiers versionnés.
- HS2 : aucun montant, référence, numéro, titre de carte ni identifiant de reçu.
- Avant publication : recherche de motifs (e-mail, numéros ≥ 8 chiffres, JWT, clés) et passage du scanner J1 sur ces dossiers : 0 alerte, 8 avertissements e-mail, tous `owner@example.invalid`.

### Constats principaux

- **Terra** est dans `agents.defaults.modelPolicy.allow` mais **pas** dans celui de `main` (ni d'`engineering-lite`). `main` la garde en 1er repli, mais elle est absente de `models.list`, de `/v1/providers` et des `models[]` du sélecteur.
- Le sélecteur voit **Gemini sous deux formes** : `google/gemini-3.5-flash-lite` (catalogue) et `…@acct-…` (repli lié au profil `claw-gemini-free`).
- **Copilot** : connecté (`static`, catalogue `ready`), quota Premium à 100 %, aucun modèle utilisé par un agent.
- `/v1/providers` : 200 en 5,6 s, avec `auth/state` « unknown » pour les 3 fournisseurs (projection de 09:54Z).
- `/agent/config` avant #167 : de 6,8 à 9,6 s en séquentiel (une lecture au-dessus de 9 s). **12 lecteurs simultanés : 12/12 en 503** après ~16,2 s, puis encore 12/12 en 503 à la vague suivante.
- **J1** : scan **partiel** (délai interne de 10 s atteint, 3 racines sur 8). 144 alertes et 85 avertissements, dont 85 « card » dans les fixtures publiques. La comparaison avec les 346 alertes de référence n'est pas possible tant que le scan reste partiel.
- **HS8** : `tools.media.models` est vide. Les exports SDK existent dans le paquet global, avec `lockedProfile` appliqué, mais `openclaw/plugin-sdk/*` n'est **pas résolvable** depuis le Companion installé (`MODULE_NOT_FOUND`, pas de `NODE_PATH`).
- **HS2** : il n'existe pas de source unique de reçus qualifiés. Les compteurs structurés complets n'existent que dans les reçus du pont, pour les exécutions passées par MCP. Aucune expiration attestée nulle part.

### Empreintes SHA-256 (fichiers rédigés ici à partir des sorties, sans copie depuis le téléphone)

```
710bb07c618540eec35c9c8a8a580b45b0c613b74314c860ed46b972504a6d31  lot-r/agent-config-selector-gemini.json
d86866b610f120cfe93477cdd001a9cc5d91102ea324cb343f95b6509c0091da  lot-r/config-models-projection.json
29c78808af33655c27d14e8c5290da261196ac7c918930420e75df6681f5659b  lot-r/immune-verdict.json
ed89766ba2a8b3b33e7a75f989c0545e1d2d31d9bd897be6b6bcd56fd19f4da4  lot-r/models.authStatus.json
2dd5a6d0c908be8eac00cfadc1ecb009eac81aea499e74262b73db4cb4781dfb  lot-r/models.list.json
53c5017a8ce75984343796bf3473360bedbcfc090a990b5db8c07a4d38203387  lot-r/providers.json
1349655da0ecce7d83be3ed6a2c44f4ed45c8ef016d82e855e84a2f841681982  lexique/resolve-mixed-phrases.json
a3b1922c549bfefde361e16fc8a5e3d8d27cbaa06434e12b50a360d9a35c10ac  agent-config/agent-config-budget-before.json
fc2400e3f3618994ca75ab3ec2ad2125ae4d71a70bca0fe10daf29d67aa0f216  j1/secret-scan-before.json
8285b97c703eb941fcfe1c3b2136fcd208b46411c565778c141b1f470e7ac780  hs8/media-config-and-sdk-resolution.json
30c0269533c03abaca60d00846f397255b1d57505f4e758f1ebda456fc2fde4b  hs2-badges/qualified-receipts-sources.json
```


---

<!-- Deuxième série de captures du même dossier (PR #173), conservée telle quelle. -->

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
