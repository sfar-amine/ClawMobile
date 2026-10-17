# HS3 — cause initiale et chronologie du handoff

La passation46 demande un complément de la projection publique `runPaymentPresentation` livrée par core180. Le propriétaire des runs et les liens run→confirmation→paiement existants restent inchangés. Aucun paiement, état, biométrie ou exécuteur n'est modifié.

## Contrat public

Le champ `presentation.payment` conserve ses champs aval `state`, `reasonCode`, `stepId`. Deux métadonnées optionnelles sont ajoutées :

| Champ | Preuve et portée |
|---|---|
| `initialFailure:{stepId:"execution_error",reasonCode,at}` | **Premier** événement execution_error du paiement lié, dans sa trace propriétaire bornée. Code public fermé ; détail précis reasonDetail s’il est un code public fermé, sinon reasonCode fermé du même événement. Aucun stack/message fournisseur ou trace brute. `at` est un epoch millisecondes positif attesté, sinon null. |
| `handoff:{runState:"done",runUpdatedAt,paymentCreatedAt,runUpdatedBeforePaymentCreated}` | État courant du run et deux dates propriétaires existantes. Booléen comparaison stricte de ces dates ; **updatedAt n'est pas completedAt**. Une valeur false ne prouve jamais une fin postérieure à la création du paiement. Champs omis si états/dates non qualifiés. |

Un premier code inconnu ou privé est omis : ne jamais chercher un échec ultérieur pour le remplacer. La trace au-delà de la borne propriétaire160 est refusée pour cette preuve. Le lecteur fermé de receiptPresentation conserve les seuls champs validés ; une métadonnée malformée/incohérente est omise, sans altérer l'état aval. Les codes publics attestés de Maxit incluent maxit_topup_command_changed, maxit_order_missing_order_id et gateway_amount_mismatch ; les codes propriétaire déjà reconnus restent fermés.

Ces champs ne prouvent **aucun débit ou non-débit**. `effect.debited` reste unknown et le marqueur financial_dispatch_committed ne disparaît pas de sa source. Dans les cas capturés, l’état done précède la création du paiement ; l’état done seul ne prouve jamais un paiement confirmé ni une réussite de l’orbe. La classification actuelle du paiement reste distincte de sa première erreur historique, même après un état ultérieur différent. La projection n'active/rejoue rien.

## Source réelle

Capture Claude184, commit `07be0bbb28a1947aacf97a8fa6222b4545bf594c`, copie byte-identique de `codex-captures-2/hs3/initial-failure-fast-path.json` dans `fixtures/s24-2026-10-11/hs3/initial-failure-fast-path.json`. Lecture du S24 runtime5631fe9, registre `~/.openclaw/clawmobile-companion/runs.json` et GETpublic ; identifiants pseudonymisés, montants/quote/draft/textes exclus. Capture176 `f036943cc63af9401e7d5e242ba3b379d61056ea` déjà conservée pour les liens et les états aval.

184 atteste trois runs done avant la création des paiements (écarts7309/14416/10393ms), et leurs codes initiaux distincts de payment_not_submitted aval. C'est une attestation des cas capturés ; la comparaison générale du projecteur ne crée aucun nouvel événement de fin. Les tests restaurent les champs/jointures explicitement capturés ainsi que la version de forme registry précisée ci-dessous, et convertissent les ISO nettoyés en epoch propriétaire ; aucun montant ou donnée privée reconstruite. Dans176, les dates masquées restent null/omises.

## Validation et livraison

Routes existantes GET `/v1/runs/:id`, GETparclient et listes de runs, même propriétaire et budgets : test HTTPlecture<1000ms ; aucun appel fournisseur/Gateway ajouté et aucun appel par ligne. Parcours paiement inaccessible depuis ces lectures. Les tests CI couvrent premier/dernier échec, reasonDetail, code inconnu, trace excessive, état/date malformés, comparaison postérieure sans inférence de fin, lecteur fermé, absence de preuve de non-débit et registre inchangé après GET. Les suites existantes de présentation et de voix sont conservées.

Les résultats ciblés/full au SHA exact sont requis avant readiness ; aucune ancienne suite ne qualifie ce delta. Raccord Orb/app après validation de ce contrat, jamais done→Success implicite. Retour arrière : retirer ces seuls champs optionnels/projecteur/tests, sans migration ni effet runtime. Claude relit, fusionne et déploie ; Codex ne le fait pas.

La capture184 nettoyée omet `decision.version` : le test HTTP restaure `version:2` du schéma registry existant pour exercer son lecteur, sans prétendre que ce champ est visible dans la capture. Le nettoyage176 masque `reasonDetail` ; le projecteur garde le `reasonCode` fermé du même premier événement lorsque le détail n’est pas un code public. Il ne consulte jamais un événement d’échec suivant.
