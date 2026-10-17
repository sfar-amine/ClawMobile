# Captures S24 pour Codex — série 2 (11/10/2026)

Lecture seule sur le S24, entre 13:02 et 13:08 UTC le 11/10/2026.

- **Accès** : connecteur MCP Claw, `claw_exec`, profil `chat-owner`, clés `cc2-*`. Scripts temporaires sous `~/.cache/tmp/cc2/`.
- **Serveur** : Companion déployé `5631fe9d6fbe9972d4fbb744bf48a2b521af0f50`. C'est le `target` de `~/.openclaw/deploys/companion-20261011T135148.json` (le plus récent), dont le `previous` est `80a683f7`.
- **Playbooks épinglés** : `2ffc0e8404506ddc927bff14b3009cd475f14c24`.
- **Appels HTTP** : loopback `http://127.0.0.1:8765/v1`, avec `Connection: close`, sans en-tête propriétaire, Origin ni Referer.
- **Interdits respectés** : aucun envoi de message, aucune mutation d'accès ou de paiement, aucun redémarrage, aucune modification de configuration.
- **Nettoyage** :
  - identifiants pseudonymisés en HMAC avec un sel jetable, donc non corrélables avec #176 ;
  - aucun numéro, nom, e-mail, montant, texte utilisateur ni jeton ;
  - textes réduits à leur longueur ;
  - clés d'idempotence libres réduites à leur longueur.

| Dossier | Fichier | Demande | Méthode | Statut | Durée |
|---|---|---|---|---|---|
| `h10/` | `control-deploys-limit20.json` | core #114 (H10) | `GET /v1/control/deploys?limit=20`, 1 appel, non différé | 200 | 201 ms |
| `k2/` | `access-change-owner-delivery.json` | core #119 (K2) | lecture du code déployé, `directory.db` en lecture seule, comptages des journaux, `GET /v1/whatsapp/allowlist/history?limit=50` | 200 | 197 ms (route) ; script 13,7 s |
| `hs2/` | `qualified-receipts-recheck.json` | playbooks #93 (HS2) | `route-health.json`, 3 000 reçus du pont les plus récents sur 8 023, `GET /v1/catalog` | 200 | 1 726 ms (catalog) ; script 2,1 s |
| `hs3/` | `initial-failure-fast-path.json` | HS3 (suite de #176 et #180) | `runs.json` + `GET /v1/runs/<runId>` ×3, journal de décision, sources playbooks | 200 ×3 | 61 à 78 ms ; script 0,5 s |

## Contrôles d'intégrité

Empreinte : SHA-256 du JSON canonique (clés triées, séparateurs compacts), calculée sur le S24 et en local.

| Capture | Ce qui est comparé | Empreinte |
|---|---|---|
| H10 | `response` | `787aa924…dfa46a`, identique |
| HS3 | sortie brute (`_capture.sha256CanonicalOnS24`) | `b6b02b61…045efb`, identique, avant ajout de `analysis` |

K2 et HS2 sont des synthèses transcrites depuis la sortie du S24. Les dates epoch de `route-health` y sont converties en ISO UTC.

## Constats

**H10.** La réponse publique est `{schemaVersion:1, state:"ok", items[20], issues:[]}`.
- Répartition des `items` :
  - `companion` : 16 `deployed` et 1 `rollback_failed` (`failedChecks:[{check:31, code:503}]`, `rollback:true`) ;
  - `app` : 3 `installed`, dont un avec `target:null`.
- `appVersion` vaut toujours `null`.

**K2.** Aujourd'hui, **aucun module n'envoie de message au propriétaire** après un changement d'accès WhatsApp.
- `people-trusted.py` (R17) écrit le reçu `send_receipts` `r17:<sha256(operationId)>`. Son seul envoi est un message de bienvenue **au contact**, quand `notify=true`.
- La primitive existante pour joindre le propriétaire est `whatsapp-owner-send.sh`, directement ou via `incident-notify.sh` / `incident-manager.sh`. Son reçu est une ligne de journal texte, et elle déduplique par empreinte du texte.
- Sur le S24 :
  - 0 reçu R17 ;
  - historique public vide ;
  - 0 ligne liée aux accès dans le journal sortant et dans la file d'incidents.

**HS2.** Il n'existe toujours **pas de source commune de reçus qualifiés**.
- `billStatus.ts` (`80a683f7`) est une projection propre aux factures, avec capability, succès vérifié et `checkedAt`, **sans expiration**. Elle sert un état vieux de 120 h.
- Elle ignore le dernier reçu de facture (11/10), qui n'a pas de bloc `execution`.
- `route-health.json` :
  - 0 champ capability, 0 champ d'expiration ;
  - 14 routes sur 25 vérifiées ;
  - dernière écriture le 10/10.

**HS3.** Trois chaînes `blocked` / `payment_not_submitted` sont liées à un run de recharge Orange.
- La troisième est apparue à 11:48:56Z, juste après #176.
- Dans chaque cas, le run est marqué `done` 7 à 14 s **avant** la création du paiement.
- Échecs initiaux, à l'étape `execution_error` :
  - `maxit_topup_command_changed` : payeur renvoyé avec l'indicatif 216, corrigé par playbooks `41b82e71` ;
  - `maxit_order_missing_order_id` : réponse WEB_VIEW ClicToPay, corrigé par `bf4586af` ;
  - `gateway_amount_mismatch` : session ClicToPay, aucun correctif constaté.
- `decision-v2-companion.log` ne contient aucune décision.
- La projection #180 n'expose pas le code fournisseur initial.
