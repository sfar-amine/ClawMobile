# P2-b — skills : détail, activation et essai

GET `/v1/skills/{id}` conserve le détail et ajoute success/state/receipt:null, examples[] (trois maximum), stats {runs,successRate,avgSeconds,lastUsedAt}, trust trusted|candidate, enabled boolean|null, activationAvailable et tryAvailable. Exemples tirés des métadonnées et sections Examples/Exemples ; statistiques des feedbacks décodables success/failure et durées explicites, inconnues null. Pas de statistique inventée, pas de promotion automatique des candidates. Fichiers réguliers, sans symlink, 2 Mio maximum.

POST `/v1/skills/{id}/enable|disable` {operationId} : seule l'entrée skills.status(main) dont filePath correspond exactement au SKILL.md du workspace donne le skillKey envoyé à skills.update {skillKey,enabled}. Confirmation du disabled attendu par readback avant completed. Ni configuration env/apiKey ni installation/suppression. Skills financières, biométriques, de confirmation ou à haut risque refusées avant réservation ; une candidate peut être désactivée sans changer sa confiance.

POST `/v1/skills/{id}/try` {operationId,instruction} : instruction explicite de 1 à 2000 caractères, skill activée, non financière, sans confirmation supplémentaire requise par ses métadonnées. Le prompt de skill existant passe par submitIntent et son routage canonique ; aucune nouvelle route d'exécution. Retour accepted et artifact {runId,sessionId}, pas completed pour un run encore actif. La conversation `skill-<id>` et le run utilisent les propriétaires actuels.

Les mutations exigent loopback et x-clawmobile-owner-flow:v1 ; Origin, Referer et Sec-Fetch-Site refusés. OperationId 1..128 caractères, lié à l'action, la skill et l'instruction via la réservation atomique du registre des runs existant. Réponse {success,state,receipt} durable ; même opération = même reçu, changement de cible/instruction = 409. Effet potentiellement commencé sans preuve = indeterminate, sans rejeu. Un propriétaire indisponible en préflight donne failed avec code fixe et receipt:null, sans réserver l'opération ; elle peut être retentée. Un essai explicitement non soumis après admission donne failed avec reçu, sans prétendre qu'il a commencé.

Source RPC : contrat skills.status/update déjà vérifié dans OpenClaw eb377ac, qualification de la version active par Claude. Base runtime 0bf30ab, aucun changement de runs.ts ni du paiement. Tests : exemples/stats, confiance candidate conservée, identité owner exacte, activation/readback, essai et reçu, replay après redémarrage, appels parallèles, refus bancaire/skill désactivée, panne avant effet rejouable et incertitude sans redispatch. Toutes les commandes CI runtime rejouées ; test P2-b enregistré dans ci.yml, toutes les étapes conservées. Claude relit, fusionne, active et recette.


## Revue 26 : protection et budgets (reprise Claude)

**Protection.** `skills.ts` et `skillControl.ts` importent `protectedPayment` / `AUTOMATION_PAYMENT_PATTERN` d'`automations.ts` (même export que R8 #47) : motif des automatisations complété par `\bpay`, montant + devise (`50 TND`, `20 EUR`…), recharge, top-up, achat/achet. `inferRisk` applique ce motif au nom, à la description, au corps complet de SKILL.md et aux métadonnées générées/candidates (fast paths compris) : ces skills sont `risk:"high"` (donc `requiresConfirmation`) et leurs fast paths héritent de `risk:"high"`. Activation, désactivation et essai sont refusés (409 `invalid_or_protected_skill`) avant réservation et avant tout appel Gateway ; le détail donne `activationAvailable:false` et `tryAvailable:false`. Testé pour « payer la facture STEG », « recharge ooredoo », « acheter un ticket », « top-up orange », « pay electricity bill » et « régler 50 TND », chacun en titre, corps et fast-path, et en instruction d'essai.

**Budgets Gateway explicites** (capture S24 du 10/10, `fixtures/s24-2026-10-10/gateway/skills.status.json` : 65 lignes, 7 skills du workspace, 1,8 à 2,4 s par appel CLI) :
- `skills.status` : `--timeout 4000`, plafond processus 5 s ;
- `skills.update` : `--timeout 6000`, plafond processus 7 s ;
- activation/désactivation : au pire 5 + 7 + 5 = 17 s (lecture fraîche, mise à jour, relecture), au lieu des défauts 10 + 5 s chaînés (~45 s) ;
- `GET /skills/{id}` : une seule lecture `skills.status` partagée par rafale (cache 15 s, invalidé par toute mutation) et attente plafonnée à 3 s ; au-delà la réponse est `partial` avec `enabled:null` et `activationAvailable:false`, la lecture continue de remplir le cache. Budget de recette 4 s.

**Recette** (`installer/termux-lite/companion-acceptance.py`) : lecture `GET /skills/clawmobile-capabilities` (skill du workspace présente sur le S24) sous 4 s, sans fuite ; `POST /skills/clawmobile-capabilities/{disable,enable,try}` sans en-tête propriétaire doivent être refusés (403) sans effet.

**Capability** : `NO_CAPABILITY`, raison « gestion des skills depuis l'écran propriétaire ; l'exposition agent viendra avec V6 ».
