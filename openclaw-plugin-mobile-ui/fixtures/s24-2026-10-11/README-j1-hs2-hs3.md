# Captures S24 du 11/10/2026 (11:39–11:48Z) : J1, HS2, HS3

Ces captures répondent aux points 5, 6 et 8 de la demande de Codex (fichier 42). Elles complètent celles de core #170 sans les remplacer. Claude les a faites sur le S24, en lecture seule.

| Élément | Valeur |
|---|---|
| Accès | Connecteur MCP Claw, `claw_exec`, profil `chat-owner`, clés d'action `cap1011-*` |
| Runtime core (`~/ClawMobile`) | `3298d98d8a29458abda6617c37ca5e4b114f4be2` (`runtime/samantha-companion-private`, arbre propre) |
| Playbooks épinglés | `9c4576a058c3c252078bac3ae802c28631447e17` |
| Écritures | Uniquement dans `~/.cache/tmp/cap1011-*` : copie temporaire du scanner #164, sorties brutes privées, scripts d'agrégation |

## Ce qui n'a pas été fait

- Pas d'installation de #164, pas de déploiement, pas de redémarrage.
- Aucune modification de configuration ou de cron.
- Le job nocturne n'a pas été lancé, donc aucun reçu `nightly-*.json` n'a été écrit.
- Aucun paiement, aucune commande Maxit, aucune consultation opérateur, aucun message.
- Rien n'a été déclenché pour HS3 : seuls des enregistrements existants ont été lus.

## Nettoyage

- **Valeurs.** Aucune valeur, aucun extrait de ligne, aucun numéro de ligne J1.
- **Identifiants.** Ils sont pseudonymisés par HMAC-SHA256 (`h_…`, `p_…`), avec un sel aléatoire propre à chaque exécution et non conservé. Les pseudonymes ne se comparent qu'à l'intérieur d'un même fichier.
- **Textes et données sensibles.**
  - Les textes libres deviennent `<texte:N car.>`.
  - Les horodatages deviennent `<horodatage>` ou un âge en secondes (`ageS`).
  - Les montants, références, bénéficiaires, `nonce`, `proof` et `fingerprint` sont exclus.
- **Contrôle.** Une recherche de motifs (e-mail, suites de 8 chiffres ou plus, JWT) sur les trois fichiers ne trouve que des empreintes hexadécimales et un taux décimal.
- **Copie.** Les SHA-256 des JSON produits sur le S24 ont été vérifiés après la copie.

## `j1/secret-scan-before-after-164.json` (core #164)

**Méthode.**
- **Avant :** le scanner installé (`7479b022…`).
- **Après :** la tête #164 `1d66b82c` (`workspace-secret-scan.py` `70b269fb…`, manifeste `f11ee3cc…`), lancée depuis une copie dans `~/.cache/tmp`, sans installation.
- **Entrées :** les mêmes des deux côtés, soit les 8 racines exactes du job « Samantha — Recette nocturne ». Chaque racine est scannée seule, et les 16 exécutions sont `state=ok`, donc complètes.
- **Classement :** chaque finding « carte » d'avant est classé sur le téléphone selon son contexte structurel. Les catégories ont été vérifiées par relecture de la seule ligne concernée.

**Résultat (8 racines) :**

| | Avant | Après |
|---|---|---|
| Cartes | 351 | **14** (−337, soit −96 %) |
| Findings actifs | 403 | 66 |
| Avertissements e-mail | 159 | 159 |
| Nouveaux findings | — | 0 |
| `accepted` | — | 0 |

Les findings non-carte sont inchangés : 40 `token`, 7 `otp`, 3 `jwt`, 2 `private_key`.

**Cartes écartées, par contexte :**

| Contexte | Nombre |
|---|---|
| Horodatage | 257 |
| Adjacence au point | 43 |
| UUID | 21 |
| Adjacence à une lettre | 11 |
| Format calendrier | 3 |
| Adjacence au tiret | 1 |
| Non résolu (`health/scheduler-health.json`) | 1 |

**Les 14 cartes restantes** sont toutes des cartes isolées, situées dans 9 sources de test versionnées : 1 dans `core_plugin`, 5 dans `core_installer`, 8 dans `playbooks`. Aucune carte isolée ne reste dans les racines runtime.

**Constats pour Codex :**
1. **La liste `accepted` ne s'applique jamais dans la configuration réelle.**
   - #164 exige le label `core` et que la racine soit le checkout du scanner. Or le job nocturne passe `core_plugin` et `core_installer`.
   - De plus, `test-workspace-secret-scan.py` est ignoré par `PRIVATE_NAME` dans la version installée, et ce fichier ne contient aucune des 14 cartes restantes.
   - Toute la réduction vient donc des règles de contexte.
   - Pour atteindre 0, il faut des signatures pour ces 9 fichiers, ou un label compatible avec les racines du job.
2. **Le passage combiné à 8 racines reste `partial` avant comme après.** Le délai interne de 10 s est atteint (`nightly8Combined`). Le reçu `nightly-20261011.json` porte d'ailleurs `secretScan.state=partial`, avec des stats à 0. La réduction ne rend pas le scan nocturne complet.
3. **Passage complémentaire `core=~/ClawMobile` (`supplementCoreLabel`) :** 103 cartes avant, 6 après, `accepted` = 0. La copie temporaire ne peut pas être ancrée sur le checkout ; l'effet réel ne sera visible qu'une fois #164 installée.

## `hs2/qualified-receipts-owner.json` (playbooks #93, contrat seulement)

**Réponse.** Aucun propriétaire unique de « reçus qualifiés » n'existe aujourd'hui. Les trois éléments utiles sont répartis entre trois sources.

**1. Reçu du pont MCP.**
- **Chemin.** `~/.openclaw/remote-bridge/requests/<requestId>.json`, avec la méthode `mcp_capability_execute_owner` ou `mcp_capability_execute_readonly`.
- **Volume.** Seulement 24 reçus de ce type : 1 de factures, 1 Orange et 1 QA (celui-ci de méthode `execute_owner`).
- **Lien à la capability.** Il est porté par `result.capability`. `result.execution.capability` n'est rempli que pour `claw.capability_runtime`.
- **Succès.** Il se lit dans `state=completed`, `result.success=true`, `execution.state=completed` et `exit_code=0`, puis dans le résultat métier :
  - `status=ok` ;
  - `coverage_complete` ;
  - `providers_checked` / `providers_requested` ;
  - par fournisseur, `has_pending`, `pending_count` et `identified_invoice_count`.
- **Fraîcheur.** Elle se lit dans `checked_at` et `completedAt`.
- **Vérification.** Le reçu embarque aussi un instantané `route_health_update`.

**2. Le « succès vérifié » proprement dit.**
- **Où.** Il n'existe que dans `~/.openclaw/skill-intelligence/route-health.json`.
- **Clé.** La clé est `cible|intention|route`, sans capability.
- **Champs.** Un événement d'historique `{result: success, verified: true}` met à jour `last_verified_at`. `verified` vaut `contract_valid` dans `retrieval/engine.py`.
- **Couverture.** Les routes `maxit-tunisie|telecom.*` n'ont jamais `verified=true`, alors que les routes `orange|telecom.*` l'ont. Le reçu Orange du pont pointe vers une clé `maxit-tunisie` dont `last_verified_at` vaut null.

**3. Reçus de domaine.**
- `billing/last-status.json` contient `status` et `coverage_complete` par fournisseur, mais aucun compteur métier.
- `runs.json` du Companion contient `decision.capability`, mais son `result` est du texte.

**Invalidation et expiration.**
- **Ce qui existe.** Les seuls mécanismes sont ceux de `route-health` :
  - les états `degraded` / `open` ;
  - `incident_id` ;
  - `suppress_until` ;
  - un historique limité à 20 événements.
- **Ce qui manque.** Aucune source ne porte d'`expiresAt`.
- **Âge des données.** Les dernières données utiles ont environ 5 jours pour les factures (428 445 s) et environ 34 h pour Orange.

**Conséquence.** Un badge exigerait une projection bornée du reçu du pont, croisée avec `route-health` pour l'état vérifié, plus une règle d'expiration à décider. Ces trois éléments relèvent d'un contrat, pas de code.

## `hs3/failed-payment-handoff.json` (point 8, reliquat HS3)

**Source.** `~/.openclaw/clawmobile-companion/runs.json`, avec ses tables `runs` (37), `paymentRequests` (24) et `ownerConfirmations` (44).

**Chaînes capturées.** Ce sont des handoffs de paiement en échec réels :
- 2 `blocked` / `payment_not_submitted`, avec trace `maxit_order_missing_order_id` ou `maxit_topup_command_changed` ;
- 2 `effect_unknown` / `payment_effect_unverified` ;
- 2 `failed` / `payment_rejected_reason_unavailable` ;
- 1 `expired` / `owner_confirmation_expired`.

Les 3 runs `failed` (hors paiement) sont joints pour comparaison.

**Constat principal.** Les deux chaînes `blocked` sont reliées à leur run, et ce run reste incohérent avec le paiement :
- `state=done` ;
- `presentation.status=info`, sans bloc `failure` ;
- `understood.capability=null`, alors que `decision.capability=payment.owner_native` et `confirmationRequired=true` ;
- `effect.debited=unknown`.

L'échec du paiement n'existe que dans `paymentRequests[].state` / `reasonCode` / `trace`. Les 5 runs `payment.owner_native` sont tous `done|info`, avec `understood.capability=null`. Pour les chaînes venues de ChatGPT (`origin.channel=chatgpt`), aucun run n'est relié.

## SHA-256

```
81871dc395876b69eb7139182fd3ba9046efbaadf8e5c24a9541a679ab37cabb  j1/secret-scan-before-after-164.json
0fa2954272aa51a6baacdd4082c6f5d0663262a8b7b77cb58acde809787a2e9d  hs2/qualified-receipts-owner.json
889bda40ada634220b0af24d792efc46b948565367f4a59fd334cefacb4f970a  hs3/failed-payment-handoff.json
```
