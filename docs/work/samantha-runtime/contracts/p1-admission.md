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
4. **Ticket opaque.** L'admission produit un objet mémoire (WeakSet), lié au `clientRunId`, à la session, à l'époque d'enrôlement et à une durée de remise de 60 s. Il n'est ni sérialisable ni restaurable depuis un journal. `turnAdmission.isCurrent` est rejoué après le chargement asynchrone du SDK, juste avant l’appel à sa façade publique. Ce point précède son bootstrap/handshake interne : il ne prouve pas une revérification immédiatement avant l’ACK Gateway.
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
  - un ticket devenu invalide avant la délégation au SDK part en non-owner ; la fenêtre interne bootstrap/handshake avant ACK reste une limite non qualifiée ;
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

## Amendements après revue adverse (« déployable après corrections »)

1. **Édition-relecture (#181).** La base a fusionné `replayOf`, qui était autorisé par l'autorité loopback. Cette autorité est retirée : `replayOf` exige `admission.admitted`. Sans preuve (loopback seul, en-tête constant ou drapeau legacy), la réponse est 403 `owner_required` et rien n'est préparé. `submitIntent` refuse aussi une relecture sans ticket. `test-edit-replay.cjs` envoie désormais une preuve valide et vérifie le 403 sans preuve.
2. **Présentation canonique de l'enrôlement.** Le Companion ne reprend plus `intent.presentation` de la demande. Il construit `enrollmentPresentation(keyId)` :
   - titre « Autoriser Samantha » ;
   - sous-titre « Messages de l’app en ton nom » ;
   - description « Clé <12 premiers caractères du keyId>… : tes messages écrits dans l’app pourront agir en ton nom. Révocable. »

   Une confirmation approuvée avec un autre texte n'est pas consommable (403). L'activité de l'app impose aussi ce texte avant la biométrie.
3. **CLARIFY (confused deputy).** Le bit `ownerAdmitted` est persisté sur chaque run.
   - Un tour admis abandonne une clarification ouverte par un tour non admis et ne la résout jamais. Aucun texte dérivé d'un tiers ne part sur la connexion admin.
   - Un tour non admis ignore une clarification admise : il ne la reprend pas et ne l'annule pas.
   - Le propriétaire existant ne reprend que la clarification du dernier run de la session. Un tour tiers intercalé la masque donc (refus fermé).
4. **Signature `callGatewayFromCli`.** Vérifiée en lecture seule sur le S24 (`claw_exec` p1adm-20261011-r03) :
   - le Companion appelle `callGatewayFromCli(method, opts, params, extra)` ;
   - `extra.scopes`, `extra.signal`, `extra.expectFinal` et `extra.timeoutMs` sont repris tels quels ;
   - `callGatewayCli` honore `opts.scopes` ;
   - empreintes identiques au paquet npm 2026.9.6.

   Fixture : `fixtures/s24-2026-10-11/p1/callgatewayfromcli-signature.json`. Le test fige la forme d'appel. La recette émet une alerte `owner_transport_unavailable` (sans retour arrière) quand un run admis est parti sur le CLI write.
5. **`ownerTransport` final** (`admin_admitted`, `write_cli` ou `write_cli_owner_unavailable`) et `ownerAdmitted` sont exposés sur le run (statut, liste) et persistés.
6. **Réponses génériques.**
   - `ownerAdmission.reason` vaut toujours `not_admitted`. La raison détaillée reste dans le journal du Companion et dans un anneau mémoire de 32 entrées, jamais en HTTP.
   - `GET /v1/owner-admission` ne renvoie ni `keyId` ni date. L'app présente son `keyId` (en-tête `x-samantha-admission-key`) et n'apprend que `keyMatches`.
   - La révocation non signée renvoie seulement 403.
7. **Fenêtre au redémarrage.** Le cache de nonces est en mémoire. Après un redémarrage du Companion, une requête signée capturée pourrait être rejouée pendant au plus 30 s, la fenêtre d'horodatage. Le rejeu exact est neutralisé par la déduplication `clientRunId` du registre durable. Un rejeu ne crée pas de second tour, et le corps signé ne peut pas changer.
8. **Permissions.**
   - `owner-turn-admission.json` doit appartenir à l'UID du Companion et n'être modifiable ni par le groupe ni par les autres ; sinon refus fermé.
   - Une lisibilité trop large est resserrée à 0600.
   - Le dossier est resserré à 0700 s'il est modifiable par le groupe ou les autres.

### Précondition de déploiement (ordre)

L'APK #183, qui signe les tours et était déjà installé sur le S24 à 14:00, **doit précéder** le Companion #182. `companion-deploy.sh` refuse (`p1_app_admission_not_installed`) le premier déploiement qui introduit `ownerTurnAdmission.ts` sans l'une des deux confirmations suivantes :
- le marqueur `~/.openclaw/deploys/p1-app-admission-installed`, posé par Claude après vérification de l'APK ;
- `COMPANION_DEPLOY_P1_APP_READY=1`.

Ensuite, Amine s'enrôle une fois. L'APK #183 installé à 14:00 envoie déjà le texte canonique en français. Seul l'affichage d'état de cette version (qui lisait `keyId`) est corrigé par le nouvel APK.

### Résiduels documentés

- `/v1/skills/:id/run` garde l'heuristique loopback pour le **contexte canonique** seulement, sans connexion admin.
- Le fast path déterministe s'exécute avec `caller:"owner"` pour tout tour loopback (comportement existant). Vérification faite : tous les effets de paiement exigent une confirmation consommée, signée par la clé biométrique épinglée :
  - `payments.confirm` vérifie la preuve owner ;
  - `local-start`, `bank_2fa` et `resume` passent par `confirmations.consume` avec l'intention reconstruite côté serveur.

  Le fast path ne peut donc pas payer sans biométrie. Les autres capabilities d'écriture du fast path relèvent de leur politique de confirmation du registre, non modifiée ici.
- L'historique de session (contexte de conversation, amorce de relecture) peut contenir des tours non admis de la même session. Ce sont des données, pas des instructions, mais elles sont transmises sur la connexion admin d'un tour admis.

## Reprise fichier 46 : preuve et frontière observée

Le correctif `28108204` ferme une révocation pendant l’await d’import du SDK public. La matrice d’admission locale passe 54/54, avec bootstrap canonique et édition/relecture verts. Le test reste inscrit dans l’étape CI P1 existante.

Un Gateway public 2026.9.6 local, avec profil/configuration/état/ports loopback et jeton jetables, a réellement exécuté un outil synthétique : owner=true pour le ticket natif local, false sans preuve, true pour un tour accepté avant révocation puis false au tour suivant. La garde hôte `assertInvocationCurrent` était appelée avant chaque effet ; elle laisse finir le tour accepté malgré la révocation Companion. Cette mesure ne constitue ni une recette Android/biométrie ni une capture S24. Annulation SDK admin et CLARIFY HTTP sont qualifiées localement dans la fixture `openclaw-plugin-mobile-ui/fixtures/local-isolated-p1-2026-10-11/`. L’annulation app et la fenêtre avant ACK restent bloquantes ; aucune CI entière finale de reprise n’est revendiquée.

## Deux entrées d’effet : ticket courant, jamais `caller` du corps

Le correctif `6283dd76` ferme la valeur constante owner dans `/runs` : le résolveur reçoit `caller=owner` seulement pour un ticket opaque courant, sinon `other`. Une décision obtenue pour un owner devenu révoqué pendant la résolution n’est pas exécutée. Le ticket est revérifié après les réservations asynchrones, avant l’exécuteur canonique. Aucun changement d’exécution paiement, d’OTP ou de biométrie.

`POST /v1/extensions/claw-live/capability` exige la même preuve P1 liée au corps brut exact, au `clientRunId` et au `sessionId`, avec nonce frais. Sans admission, refus 403 avant résolution/effet. Le chemin signé est le pathname original exact, même après résolution de l’alias interne. L’app utilise `clientRunId=voice-cap-<turnId>` et capture la session avant l’async ; aucun retry non signé. Le ticket mémoire n’est ni dans le corps, ni persistant. Il protège aussi l’exécution préparée dans `SurfaceClarifications`, puis le bridge final et l’admission warm/learning. La clarification est liée à `SurfaceClarifications.idFor("claw-live:" + sessionId)` ; une question précédente ne vaut jamais admission du tour suivant. `/claw-live/decision` reste une résolution seule.

Les 64 cas natifs, les 21 cas voix HS3, les 44 contrôles E3 et l’édition/relecture ciblés passent. Les mutations native/voix sont vérifiées dans la recette existante par refus sans preuve ; aucune mutation autorisée n’est envoyée par cette recette. Les actions métier restent les capabilities du registre/Graph existants.

Le complément `84b8a0ed` revérifie l’admission avant un nouvel effet de learning après `await execute`. Si elle n’est plus courante, le reçu de l’effet déjà accepté est conservé et le learning est omis (`skipped`, `owner_admission_expired`), avec zéro capture. La recette `197221f7` vérifie le refus capability voice sans signature.
