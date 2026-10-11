# Captures S24, vague 5 (10-11/10/2026), en lecture seule

Ces fichiers ont été capturés par Claude sur le S24 dans la nuit du 10 au 11/10/2026, entre 00:29 et 00:52 (heure de Tunis). Ils ont été nettoyés sur le téléphone avant publication. Ils répondent aux demandes de captures de Codex : core #107, #111, #113, #110, #122, #124 et playbooks #57, #69.

| Élément | Valeur |
|---|---|
| Accès | Connecteur MCP Claw, `claw_exec`, profil `chat-owner`, clés d'action `cap1b-*` |
| OpenClaw | `2026.9.6 (eb377ac)` |
| Runtime core (`~/ClawMobile`) | `5de1c492fe4a8f140c823848ee5bd1d884cd4c02` (`runtime/samantha-companion-private`) |
| Playbooks épinglés | `6d567aa3252ff398513bd7c7b22ed63da7a31ffe` (espace de travail : `dd251b7`) |
| Release tier0 courante | `20261010T120821-d3beb769` (source `066a340`) |

## Ce qui n'a pas été fait

- Aucune consultation opérateur : pas de Maxit ni de télécom en direct, pas de bascule Wi-Fi/4G.
- Aucun paiement, ni quote ni exécution.
- Aucun appel de modèle : pas de `provider_call`, pas de tour d'agent.
- Aucune mutation du runtime.

Les seules écritures ont lieu dans `~/tmp/cap1b/`, un dossier de travail jetable : sorties, et vues de capacités compilées via `CLAW_CAPABILITY_VIEW_DIR`. Les SQLite sont ouverts en `mode=ro`. Les résolutions passent par `capability_graph resolve`, sans `execute`.

## Nettoyage

- **Identifiants.** Ils sont pseudonymisés par HMAC-SHA256, avec un sel aléatoire propre à l'exécution et non conservé. Préfixes : `run_`, `sess_`, `req_`, `ref_`, `h_`… Les pseudonymes sont cohérents à l'intérieur d'une même génération.
  - Générés ensemble à 00:46 : `p1`, `o7-o8`, `o9`, `hs2`, `o6`.
  - Régénérés seuls, donc avec un autre sel : `k1` à 00:49 (SHA Git laissés en clair) et `hs3-terminal-receipts` / `hs3-resolution-…` à 00:51 (zéros conservés). On ne peut pas comparer leurs pseudonymes avec ceux des autres fichiers.
- **Montants.** Ils sont remplacés par des valeurs fictives de même format : même nombre de décimales, millimes cohérents. Les zéros restent des zéros.
  - Pour les 8 cartes Orange, `value_format` donne la forme réelle (`99.999`…). Les titres, unités, validités (`days_remaining`), `kind` et `section` sont réels.
- **Texte libre.** Tout texte libre qui n'est ni un code ni une date devient `<texte:N car.>`. Font exception les libellés publics : titres, noms de capability, questions d'extracteur.
- **Retiré.** Ni audio, ni transcription, ni secret, ni jeton, ni OTP, ni carte, ni e-mail. Avant publication : recherche de motifs (e-mail, IP, numéros ≥ 8 chiffres, JWT, montants réels connus), résultat nul.
- **Vérification de copie.** L'empreinte SHA-256 de chaque fichier a été comparée entre le S24 et le dépôt.

## Fichiers

### `p1-owner-identity-by-surface.json` (core #107, P1)

**Source.** Table `trajectory_runtime_events` des bases `openclaw-agent.sqlite` des agents `main` et `gemini`. On y lit la métadonnée host `__openclaw.senderIsOwner` du dernier message utilisateur, par surface, ainsi que tous les appels `clawmobile_capability` (arguments `caller`, `execute`, `surface`).

**Constat principal.** Sur l'app (`companion-chat`), les deux tours du 10/10 (16:15 et 21:19 UTC) se présentent ainsi :
- le host a écrit `senderIsOwner:false` ;
- le modèle a pourtant appelé `clawmobile_capability` avec `caller:"owner", execute:true`.

Le code déployé (`5de1c49`) l'explique :
- l'outil est enregistré de manière **statique** (`api.registerTool(toolDef(...))`), sans factory, donc sans contexte de tour ;
- `capabilityTool.ts` contient `const caller = args.caller || "owner";` ;
- `assertInvocationCurrent` est absent.

**Valeur de `senderIsOwner` par surface :**

| Surface | `senderIsOwner` |
|---|---|
| WhatsApp | 19 `false` (non-owner) et 2 `true` |
| App | toujours `false` (le fast path admet l'app par `isTrustedLocalCompanionSession`) |
| MCP | toujours `false` |
| Session `node` | toujours `true` |
| Canal Gemini (`agent:gemini:channel-…`, classé `other`) | `true` |

**Limite.** Le **contexte factory** (`ctx.senderIsOwner`, `assertInvocationCurrent`) n'existe pas sur le runtime déployé. Il ne pourra être capturé qu'après déploiement de #107, avec un tour réel, ce qui suppose un appel de modèle (interdit ici).

**Voix.** Aucun tour voix ne passe par un tour d'agent OpenClaw : la voix écrit par `/sessions/{id}/voice-turns`. Rien n'est donc journalisé pour la voix.

### `o7-o8-orange-20261010-0941.json` (core #113 O7, #111 O8)

**Source.** Run Companion `capability_first` « Mon solde Orange » du 10/10. Il a été accepté à 09:41:02 et s'est terminé à 09:41:08 (6 533 ms de bout en bout). La ligne `telecom/runs.jsonl` correspondante donne un service de 709 ms, et `route-metrics.jsonl` une entrée gardée de 5 840 ms.

**Contenu.** Le fichier contient :
- l'enveloppe de décision v2 ;
- le `result` reçu par le client, avec ses **8 cartes** `data.cards` ;
- la provenance.

Le plan était `orange.summary.maxit.v1` ; le propriétaire a exécuté `orange.usage.maxit.v1`, transport `https_waaat`. **Ni `execution.actual_route` ni chemin réseau O1** ne sont enregistrés dans ce run.

**Résolution actuelle, pour la même intention.** Elle a été obtenue par `capability_graph resolve` sur `gemini_claw` et sur `claw_live` (résolution seule).

**Indice `gemini_claw` actuel.** Il a été obtenu par `gemini-request.py::capability_hint()`, puis `build_prompt()` a été appelé localement, sans `provider_call`. Le prompt contient bien `CAPABILITY_HINT=`.

### `o9-voice-unknown-runs.json` (core #110, O9)

Les 3 runs voix `state=unknown` du registre `clawmobile-companion/runs.json` (version 1, 17 runs), datés des 08/10 et 09/10, ont tous `transcriptState=interrupted`. Cet état est terminal selon `terminal()` dans `runs.ts`, mais le run n'est mis à `done` que si `transcriptState=completed`.

Les runs n'ont ni `playback`, ni `clientRunId`, ni `decision`. Aucun autre stockage ne référence leurs identifiants.

Le propriétaire de la réconciliation est `saveVoiceTurn` (`runs.ts` l.1738), appelé par POST `/sessions/{id}/voice-turns`.

Seules les longueurs d'entrée et de sortie sont publiées.

### `hs3-terminal-receipts.json` et `hs3-resolution-slots-shortlist.json` (core #124, HS3)

**Reçus terminaux** (reçus canoniques du pont `remote-bridge/requests`, lus par `continuum_runtime`) :

| Famille | Reçu |
|---|---|
| Factures | `billing.utility.fast_path` du 06/10, STEG, SONEDE et Topnet ; montants fictifs |
| Device | `device.assistance` Wi-Fi (pont) et batterie (run Companion) |
| Laptop | `device.laptop_termux_access`, statut |
| QA | `qa.test_campaign`, opération `docs` |
| Pulse | **aucun reçu `claw_execute`** ; seule existe la continuation foreground terminale de la livraison forecast |
| Agenda | **aucun reçu `claw_execute`** ; seule existe la trace de recette `agenda/acceptance-move.json` (événement « TEST Samantha ») |
| Orange | voir `o7-o8` |

**Résolutions avec la shortlist du harness.** Elles couvrent volume, agenda (déplacement et création) et recharge Orange, avec ou sans montant.

**Slot validé.** `payments/request_handoff.py::_parameters()` (fonction pure) donne :
- « … de 5 dinars » : `{"amountTnd":"5"}` ;
- sans montant : `needs_parameter`, avec `financialSubmissionAttempted:false`.

La sortie `resolve` ne contient que `requiredSlots` et le contrat d'extraction, pas les valeurs.

**Constats, sans correction :**
- « Projets Pulse ouverts » sélectionne `applications.authentication.direct` (0,919), à égalité avec `pulse.backend_first` (0,919).
- Pour « Paye ma facture Topnet », « Recharge mon numéro Orange » et « … de 5 dinars », la capability retenue est `payment.owner_native`, mais la shortlist du harness ne la contient pas.

**Question : quel champ public prouve l'absence de débit après une tentative refusée ?**

Lecture de `openclaw-plugin-mobile-ui/src/companion/paymentCore.ts` (commit `aa5fe96`) et de `payments.ts`.

**Réponse : ce champ n'existe pas.** `effect.debited` doit rester `unknown`.

1. **Champs exposés.** `paymentView()` expose `state`, `reasonCode`, `financialSubmissionAttempted`, `timeline`, `receipt` (seulement si `confirmed`) et `metrics`. `compactPaymentUiView()` n'expose que `state`, `reasonCode`, `quote`, `financialSubmissionAttempted`, `progress` et `receipt`. Aucun champ `debited`, `noDebit` ou `rejectionVerified`.
2. **`rejectionVerified` n'est pas conservé.** C'est un champ du résultat d'adaptateur. `applyResult()` (l.240) s'en sert comme barrière : un `failed` sans `rejectionVerified===true` devient `effect_unknown/payment_rejection_unverified`. Ensuite, seul `finish(id,"failed",reasonCode)` est écrit.
3. **Ce que `state:"failed"` garantit.** En mode live, avec `financialSubmissionAttempted:true`, un `state:"failed"` public implique, par invariant de code, que l'adaptateur a déclaré `rejectionVerified:true`. Les raisons possibles sont `bank_declined`, `bank_verification_failed`, `payment_cancelled`, `session_expired` et `payment_rejected_reason_unavailable`. Même chose pour `cancelled` après réconciliation de délai (l.468). Mais c'est une **preuve de refus vérifié par l'adaptateur**, pas une observation du solde. Aucun champ ne l'énonce comme absence de débit.
4. **Indice secondaire.** `timeline[].invoiceState` (`unpaid`, `settled`, `balance_changed`, `not_observed`, `unknown`) peut porter une observation de facture après la tentative. C'est un indice, pas une preuve de non-débit.

### `hs2-guards-and-pc-capabilities.json` (playbooks #69, HS2)

**Propriétaire installé.** `payment.owner_native` : `core.capabilities()`, servi par GET `/payments/capabilities`. Il faut l'en-tête `x-clawmobile-owner-flow: v1`, et toute origine navigateur est refusée. La projection est `adapters[] {id,label,mode,executionValidated,localOwnerValidated,reasonCode}`.

**Maxit.** Le fichier de garde `maxit-topup-live-acceptance.enabled` est présent et a la valeur attendue (08/10, 09:58). La garde est lue au démarrage pour `localOwnerValidated`, puis relue à l'exécution. Le `reasonCode` vaut `maxit_live_acceptance_pending` quand la garde est armée.

**Topnet.** La garde `topnet-live-acceptance.enabled` est **absente**. C'est une garde à usage unique, consommée à l'exécution. Son état armé n'est **pas** projeté : `localOwnerValidated` est codé en dur à `true`.

La route n'a pas été appelée, pour ne pas manipuler le jeton owner.

**Appairage et révocation PC.**
- Ils relèvent de `device.laptop_termux_access` : entrées `pair-start`, `pair-status`, `pair-commit` et `revoke`, déployées dans `device/laptop_access.py`. Routes Companion `/laptop-access/*`. La révocation exige une confirmation owner consommée (`laptop_access.revoke_key`).
- Aucune capability `samantha.app.*` ne les couvre.
- `agent.examples` ne couvre ni l'appairage ni la révocation.
- La note `last_engineering_change` du registre indique encore « not deployed ».

### `k1-update-candidates-source.json` (core #122, K1)

**Propriétaire.** GET `/updates` passe par `updatesControl.ts`, puis `installer/termux-lite/tier0-native-read.py`. Les candidats sont `available[]`, c'est-à-dire les releases tier0 Termux-lite plus récentes que `current`. Sortie actuelle : `available: []`, `updateAvailable: false`.

**Dépôt physique.** `~/ClawMobile` (`.git`), branche `runtime/samantha-companion-private`, HEAD `5de1c49`. Il y a 69 releases.

**Couple réel précédent → courant.**
- De `20261010T113438` (`99f5a2a`) vers `20261010T120821` (`066a340`).
- Les objets sont présents et la relation d'ascendance est vérifiée. L'intervalle compte 3 commits.
- Il contient une note `docs/changes` en **version 1** (pas v2), avec un `summary` en anglais.

**Entre `066a340` et la HEAD runtime.** 321 commits et 35 notes v2. Ce n'est pas un candidat tier0 : aucune release n'a été construite. Il n'existe **aucun champ de résumé français dédié** : `summary` est libre (6 en français, 29 en anglais ou autre selon une heuristique).

### `o6-network-guard-timing.json` (playbooks #57, O6)

**Données.** 8 runs Maxit https gardés depuis le 07/10, appariés entre `route-metrics.jsonl` (entrée gardée totale) et `telecom/runs.jsonl` (service).

| Mesure (ms) | p50 | p95 | max |
|---|---|---|---|
| Entrée totale | 5 622 | 6 177 | 6 309 |
| Service | 790 | 1 052 | 1 099 |
| Surcoût du garde (total − service) | 4 731 | 5 373 | 5 504 |

**Préparation, DNS, nettoyage et restauration ne sont pas mesurables séparément.**
- Le bail `wifi_off` est supprimé après restauration.
- `network-mutation-safety.json` est écrasé à chaque passage, sans durée.
- `ready_ms` est calculé mais jamais écrit.

**Bornes lues dans le code :**

| Constante | Valeur |
|---|---|
| `MAX_LEASE_AGE` | 900 s (`NETWORK_MUTATION_MAX_LEASE_AGE`) |
| `set_wifi` | 8 s |
| Appel adb | 6 s |
| `MOBILE_READY_TIMEOUT_S` | 8 s |
| Enfant de service | **aucun délai maximal** dans le code déployé |

**Proposition de Claude, non déployée : borne totale de 60 s.**
- Bornes de code hors service : environ 24 s. Plafond du service : 30 s, soit environ 27 fois le maximum observé.
- La borne fait environ 9,5 fois le maximum total observé. Elle reste très en dessous du bail de 900 s, sans renouvellement.
- Le plafond O1 (enfant 120 s + nettoyage 1,5 s) reste lui aussi sous 900 s.

## Latences `/v1/usage` et `/v1/runs?limit=50` (11/10, 06:53-07:28, tâche perf)

`perf-usage-runs-latency.json` regroupe des mesures **en lecture seule** faites par Claude sur le S24 (clés `perf-usage-runs-*`, runtime `59227f0e`, OpenClaw `2026.9.6`). Il ne contient que des durées et les reçus de déploiement concernés : aucun corps de réponse, identifiant, texte ni secret. Contrairement aux autres fichiers de ce dossier, il a été rédigé ici à partir des sorties des commandes, pas copié depuis le téléphone ; il n'a donc pas d'empreinte S24.

- Appels `openclaw gateway call` : `health` 2,27 s côté CLI pour 32 ms côté Gateway, `usage.status` 2,6 à 4,1 s, `sessions.list` 1,7 à 4,3 s, `chat.history` 1,9 à 2,8 s.
- Banc `listRuns` : copie temporaire de `runs.json` sous `~/tmp/perf-bench` (supprimée ensuite), run Gateway le plus récent remis à `running`. Le registre et le Companion réels n'ont pas été modifiés.
- `injectedLatencyMs` sert au test CI `scripts/test-usage-runs-latency.cjs`.

## P1 après déploiement : admission par la factory du Gateway (11/10, 02:00-08:16Z)

`p1-factory-admission-after-deploy.json` est la capture P1 demandée en core #107, faite après la fusion `7210959c` et son déploiement (reçus `companion-20261011T024525.json` et `gateway-plugin-20261011T015736.json`). Comme `perf-usage-runs-latency.json`, elle a été rédigée ici à partir des sorties des commandes, pas copiée depuis le téléphone ; elle n'a donc pas d'empreinte S24.

- **Gateway rafraîchi.** Le Gateway charge le plugin depuis `~/.openclaw/extensions/`, que `companion-deploy.sh` ne met pas à jour. La copie a été rafraîchie par `clawmobile_install_plugin`, avec sauvegarde puis redémarrage via `POST /v1/runtime/restart`.
- **Sonde sur les octets chargés par le Gateway.** Enregistrement en factory, sans outil statique. 12 refus `caller_not_admitted` (app, WhatsApp, MCP, voix ; bit absent, non booléen ou invocation expirée), 0 helper lancé.
- **Origine du bit.** OpenClaw 2026.9.6 calcule `senderIsOwner = hasGatewayAdminScope(client)`. Le bit vient du client authentifié, jamais des arguments d'outil.
- **Tours réels inoffensifs.**
  - App : `senderIsOwner:false` posé par l'hôte.
  - MCP : `caller` owner posé par le pont authentifié.
  - WhatsApp non capturé : aucun canal owner provocable sans Amine, et le tour owner de 02:00Z a échoué avant le modèle, sur la compaction `codex`.
  - Voix sans tour OpenClaw.

## Empreintes SHA-256 (identiques sur le S24 et ici)

```
708a0ebe5fda0eea13c6689fe45461d526108136b96c49abdc1aebb3a234600a  p1-owner-identity-by-surface.json
b19e9aa8b46a4b24952fea45683486658aaa5af10e2a496c7a9cc8b12a5614f7  o7-o8-orange-20261010-0941.json
30c29b2821edde1c2b496730ef877c4c96cb3b4c3b0beea4dcfbc703ebe72577  o9-voice-unknown-runs.json
4f0a81ce75bcbc6328a28aded742940514dce11ed452901d201b03c7924557fb  hs3-terminal-receipts.json
b56621b8fa6f9032e0fd50fe82d6178d2042f138144454de7424a0e339b67df8  hs3-resolution-slots-shortlist.json
af32874795cfd429f7ff74fb8343c2b7ac585c40fb3e593ac9d1fd75296d0b8b  hs2-guards-and-pc-capabilities.json
a2fd37ce265fd54ef4fb2f068ac43c4d2e122138df1faec4cffee2df3b873915  k1-update-candidates-source.json
118317e7c8ad84637ed990bde90d51184d2a133ccd46e50bc7c4b11c46ea9125  o6-network-guard-timing.json
```
