# P1 — Admission native des tours owner de l'app

Contrat : playbooks #87, fichier 43, version 2 (branche `docs/p1-admission-contract-v2-20261011`). Revue Claude [6108649302](https://github.com/sfar-amine/samantha-ui-playbooks/pull/87#issuecomment-6108649302). Captures : core #172, `fixtures/s24-2026-10-11/p1/` (recopiées ici à l'identique). Demande d'Amine : « important à corriger ».

## Problème

Depuis le correctif P1, les tours texte de l'app arrivent au modèle avec `senderIsOwner:false`. Seul le fast path déterministe du Companion exécute les routes connues. Le Companion déployé posait `authority:"owner"` sur le seul critère loopback (`server.js:1171`). Tout processus local (Termux, autre app Android avec INTERNET) pouvait reproduire cette condition. Côté Gateway, `operator.admin` est accordé à tout détenteur du jeton partagé et le bit owner vaut pour toute la connexion.

## Frontière livrée

1. **Clé par installation.** L'app génère dans l'Android Keystore une clé EC P-256 de signature, non exportable, alias `claw.owner.turn-admission.v1`. Elle est distincte de la clé biométrique `claw.owner.confirmation.v1` et n'exige pas de biométrie par message. `keyId` = sha256 du SPKI DER.
2. **Enrôlement gardé par la biométrie.** Le flux réutilise le propriétaire canonique des confirmations, sans nouveau registre :
   - l'app prépare une confirmation `owner.turn_admission.enroll`, avec `reference = payloadHash = keyId` et `origin = samantha/turn-admission` ;
   - `OwnerConfirmationActivity` refuse avant la biométrie toute demande dont le `keyId` n'est pas celui de sa propre clé, ce qui bloque l'enrôlement par une autre app via l'activité exportée ;
   - la clé biométrique épinglée signe ;
   - l'app envoie `POST /v1/owner-admission/enrollment` avec `{confirmationId, publicKey, possession}`, où `possession` est la signature de la nouvelle clé sur `claw.owner.turn-admission.enroll.v1\n<confirmationId>\n<keyId>` ;
   - le Companion vérifie la possession, puis consomme la confirmation (binding exact, preuve biométrique, usage unique) ;
   - il écrit `~/.openclaw/clawmobile-companion/owner-turn-admission.json` (mode 0600 : clé publique, `keyId`, époque aléatoire). Un seul enrôlement ; un ré-enrôlement remplace la clé et change l'époque.
3. **Preuve par requête** sur `POST /v1/runs`. En-têtes `x-samantha-admission: v1`, `-key`, `-ts`, `-nonce`, `-signature` (ECDSA SHA-256, DER base64). Message signé :

   ```
   claw.owner.turn-admission.v1
   <méthode>
   <chemin exact, sans requête>
   <sha256 hex du corps exact envoyé>
   <clientRunId>
   <sessionId normalisé>
   <horodatage ms>
   <nonce hex>
   <keyId>
   ```

   Le Companion vérifie, dans cet ordre :
   - la forme (un en-tête répété est refusé) ;
   - l'absence d'en-têtes navigateur ;
   - l'enrôlement et la clé ;
   - la fenêtre de ±30 s ;
   - la signature ;
   - le nonce, vérifié **après** la signature : cache mémoire de 2 048 entrées, TTL de 65 s, refus si le cache est plein.

   Tout échec donne un tour non-owner. La réponse porte `ownerAdmission: {owner, reason?}`.
4. **Ticket opaque.** L'admission produit un objet mémoire (WeakSet), lié au `clientRunId`, à la session, à l'époque d'enrôlement et à une durée de remise de 60 s. Il n'est ni sérialisable ni restaurable depuis un journal. `turnAdmission.isCurrent` est rejoué juste avant la remise au Gateway.
5. **Deux connexions.** Seul un ticket courant ouvre la connexion admin (`ownerTurnGateway.submitOwnerTurn`) :
   - elle passe par `callGatewayFromCli` du plugin-sdk OpenClaw 2026.9.6 installé (bootstrap, SecretRef et handshake du propriétaire OpenClaw) ;
   - scopes `operator.admin` et `operator.write` ;
   - méthode `agent` uniquement, une connexion par tour, fermée après la réponse.

   Tous les autres tours gardent le CLI canonique en `operator.write` : non admis, skills, apprentissage, voix. Le champ `authority` (contexte canonique) ne choisit jamais la connexion. Le pool Control P0-1 (#68) n'est pas touché et garde `agent` et `chat.send` hors de son chemin.
6. **Échecs.**
   - SDK absent ou version différente **avant envoi** : le tour part en non-owner sur le CLI (`write_cli_owner_unavailable`).
   - Erreur **après envoi** : run `failed`, sans repli CLI ni rejeu.
   - Rejeu exact : refusé par le nonce, puis dédupliqué par `clientRunId` (aucun second tour).
7. **Heuristique loopback retirée de `/v1/runs`.** Le drapeau de compatibilité `CLAWMOBILE_RUNS_LEGACY_LOOPBACK_CONTEXT=1` est **OFF par défaut**. Il ne rend que le contexte canonique (prompt) aux tours loopback non admis, jamais la connexion admin. Il ne sert qu'à la fenêtre de déploiement, avant l'enrôlement.

## Révocation, cron, `/reset`

- **Révocation par l'app** : `DELETE /v1/owner-admission/enrollment`, signée par la clé enrôlée (`clientRunId = operationId`, session `owner-admission`).
- **Révocation par l'opérateur** : supprimer `owner-turn-admission.json` ; l'effet est immédiat, le fichier est relu à chaque vérification.
- **Effet de la révocation** :
  - les tickets émis ne sont plus courants ;
  - un tour admis mais pas encore remis part en non-owner ;
  - un tour déjà remis au Gateway se termine avec le bit figé à l'acceptation, sans annulation forcée ;
  - les tours suivants sont non-owner.
- `/reset` via `agent` exige admin : seul un tour admis l'atteint.
- `restoredCronContinuation` force owner dans OpenClaw. Les reprises cron restent hors de ce contrat et demandent leur propre audit.

## Routes

| Route | Budget | Capability |
|---|---|---|
| `GET /v1/owner-admission` | 0,5 s (lecture locale d'un fichier) | `NO_CAPABILITY` : état de sécurité natif, ni exposé à l'agent ni à la voix |
| `POST /v1/owner-admission/enrollment` | interactif (biométrie) | `NO_CAPABILITY` : appairage owner, jamais déclenchable par l'agent |
| `DELETE /v1/owner-admission/enrollment` | < 0,5 s | `NO_CAPABILITY` : révocation native signée |
| `POST /v1/runs` | inchangé ; vérification ECDSA 0,13 ms mesurée en local x86, à mesurer sur S24 | inchangée |

Les lignes `companion-acceptance.py` sont ajoutées : une lecture, plus les refus sans en-tête propriétaire.

## Limites résiduelles

- Les processus de l'UID Termux détiennent déjà le jeton Gateway et le fichier d'enrôlement. Ils restent équivalents owner, ce que ce contrat ne change pas. La frontière protège contre les autres apps Android et les requêtes loopback non authentifiées.
- La clé d'admission n'exige pas de biométrie par message. Un attaquant qui contrôle l'app déverrouillée peut signer. Cette limite est assumée par le contrat, puisqu'il n'y a pas de biométrie par message.
- Le bit owner reste lié à la connexion côté Gateway. L'isolation repose sur une connexion admin par tour admis.
- `/v1/skills/:id/run` garde l'heuristique loopback pour le **contexte** canonique, sans connexion admin.
- Captures restant à faire sur un Gateway isolé (jamais avec le jeton réel du S24) : tour owner/non-owner réel, révocation pendant un tour, annulation et CLARIFY.

## Retour arrière

Le revert de la PR restaure le comportement précédent : non-owner partout, contexte via loopback. Le fichier d'enrôlement est ignoré par l'ancien code. Le déploiement reste fait par Claude via `companion-deploy.sh`.
