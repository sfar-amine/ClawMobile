# Captures S24 P1 : admission native, scopes accordés et bit owner (11/10/2026)

Capture nettoyée demandée par Codex (playbooks #87, item 2) avant toute implémentation de l'identité owner des tours natifs. Elle qualifie la question : le Companion peut-il porter l'identité owner par une admission attestée par l'hôte et un scope admin Gateway réellement accordé ?

| Élément | Valeur |
|---|---|
| Accès | Connecteur MCP Claw, `claw_exec`, profil `chat-owner`, clés `p1cap-20261011-a01..a25` |
| OpenClaw | `2026.9.6 (eb377ac)`, Gateway `local`, bind loopback, port 18789, auth `token` (SecretRef), `trustedProxies` vide |
| Runtime core déployé | `3298d98d8a29458abda6617c37ca5e4b114f4be2` |
| P0-1 relu (non déployé) | `377ddcaeacb153a3dade79d880606e8955f052a0` (core #68) |
| Contrat relu | playbooks #87 @ `0d35777f` |

## Méthode (lecture seule)

Un client WebSocket jetable, avec le module `ws` du paquet OpenClaw installé, envoie un `connect` protocole 4, `role: operator`, sans identité d'appareil. Le jeton partagé est résolu en mémoire par `plugin-sdk/config-runtime` et `secret-ref-runtime`. Il n'est jamais affiché ni écrit. Après `hello-ok`, une seule RPC est émise : `models.list`, en lecture. On enregistre les scopes demandés, les scopes accordés (`hello-ok.auth.scopes`, c'est-à-dire ceux que lit `clientHasAdminScope`), et le refus éventuel.

Ce qui n'a pas été fait :
- aucun tour `agent` ou `chat.send`, ni aucun appel de modèle ;
- aucun `POST /v1/runs` ;
- aucune modification de configuration, aucun redémarrage, aucun déploiement ;
- aucune révocation du jeton ou des appareils.

Le dossier temporaire `~/.cache/tmp/p1cap` a été supprimé.

## Résultats clés (`p1-owner-transport-admission.json`)

| Cas | Accordé | Owner dérivé |
|---|---|---|
| Sans identifiant, loopback, admin demandé | refus `NOT_PAIRED/DEVICE_IDENTITY_REQUIRED` | non |
| Sans identifiant + `x-clawmobile-owner-flow: v1` | refus `NOT_PAIRED` | non |
| Sans identifiant + `x-forwarded-for` | upgrade refusé, HTTP 403 | non |
| Mauvais jeton | refus `AUTH_TOKEN_MISMATCH` | non |
| `senderIsOwner`/`authority` dans `connect` | refus `INVALID_REQUEST` (schéma fermé) | non |
| Jeton valide, `cli/cli`, union P0-1 | admin/read/write/approvals | **oui** |
| Jeton valide, `gateway-client/backend`, union | admin/read/write/approvals | **oui** |
| Jeton valide, `cli/cli`, `[write]` ou `[read]` | identique à la demande | non |
| Jeton valide + `Origin` forgé | `[]` (scopes effacés), `models.list` → `MISSING_SCOPE` | non |
| Jeton valide, `openclaw-android/ui` | `[]` | non |
| Deux connexions simultanées admin / write | indépendantes (admin / write) | oui / non |
| Reconnexion après fermeture admin, demande `[write]` | `[write]` | non |

## Constats

1. **Côté Gateway, l'autorité vient du jeton partagé, jamais du loopback, des en-têtes ou des champs du `connect`.** Sans jeton, ou avec un `Origin` ou un en-tête proxy, aucun scope n'est accordé.
2. **`operator.admin` est auto-déclaré par tout détenteur du jeton**, en `cli/cli` local ou `gateway-client/backend` (`message-handler…mjs:1124`). L'hôte n'atteste que la possession du jeton, pas un humain ni un tour.
3. **Le bit owner porte sur toute la connexion.** Il vaut `senderIsOwner = clientHasAdminScope(client)` (`agent-turn-service…mjs:2397`, `chat-send-handler…mjs:4665`), et `restoredCronContinuation` le force à `true`. Il n'est lié ni au `runId` ni à la session. Une soumission non admise sur la connexion admin serait owner.
4. **Côté Companion (déployé `3298d98d`), il n'existe aucune admission native authentifiée.**
   - `POST /v1/runs` pose `authority: "owner"` sur le seul critère loopback, sans en-têtes navigateur (`server.js:1171`).
   - Les mutations owner exigent seulement l'en-tête constant `x-clawmobile-owner-flow: v1`.
   - L'app Android n'envoie aucun secret.
   - Tout processus local (Termux, ou app Android avec INTERNET) reproduit ces conditions. `GET /v1/runs` renvoie 200 sans en-tête et 403 seulement avec `Origin`.

## Plans non exécutés (mutation de l'appairage réel requise)

Révocation, annulation et tours concurrents : voir `test_plans_not_executed` dans le JSON. Ils sont à jouer sur un Gateway de test isolé, avec un profil, un port et un jeton jetables, jamais sur le jeton réel du S24.

## Nettoyage

- Les `connId` sont pseudonymisés en `h:` suivi des 10 premiers caractères de sha256.
- Aucun jeton, aucune clé, aucun texte utilisateur.
- Recherche de motifs (hex ≥ 40 hors SHA Git, JWT, e-mail) : résultat nul.
