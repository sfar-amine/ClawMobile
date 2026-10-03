# Programme de confirmation native des paiements

Composant partagé du runtime Claw sur S24. Le client Python payments.cli appelle le Companion existant ; l'activité OwnerConfirmationActivity de Samantha Android présente l'autorisation au propriétaire. Les sites gardent des adaptateurs distincts.

Seul demo.confirmation est actif et ne réalise aucune transaction. Les autres adaptateurs sont bloqués avant réseau. La seconde étape bancaire et le reçu réel ne sont pas implémentés.

La signature P-256 est liée à la demande exacte, au montant/fournisseur/référence, au mode, à une expiration et à la clé publique épinglée par l'installation. Aucun Intent ni booléen JSON ne peut approuver l'opération. Le registre runs.json conserve les gardes de rejeu, indépendamment de la rétention des conversations. Les lectures et appels sont bornés ; un effet inconnu ne se rejoue pas.

Contrat canonique et usage : dépôt privé samantha-ui-playbooks, payments/README.md et capabilities/howto/payment.owner_native.md. Architecture : ADR-20261003-native-payment-confirmation.md dans ce même dépôt.

Source et tests sont préparés en isolation. L'installation native et la recette matérielle sont suivies séparément ; aucune confirmation Termux antérieure ne vaut preuve pour ce nouveau protocole. Restaurer uniquement l'APK et le runtime précédents en conservant les données et sans rejouer de demande.

## Confirmation transverse
OwnerConfirmationActivity est commune aux demandes génériques (/v1/confirmations, extra confirmation_request_id) et aux paiements spécialisés (/v1/payments, extra payment_request_id). Aucun titre ni décision dans les extras. NativeOwnerProtocol lie le texte, action/type/reference/payloadHash et origine ; domaine claw.owner.confirmation.v1 distinct de claw.payment.owner.v1. Le registre existant conserve ownerConfirmations. La route confirme seulement, sans exécuteur ni callback. Consommation atomique réservée aux consommateurs intégrés dans le processus de confiance. Le client Python commun est confirmations.cli. Les détails et limites canoniques résident dans ui-playbooks/confirmations/README.md.

## Recette installée le 3 octobre 2026
Application v0.6.0-native-dev installée en préservant les données. Clé publique provisionnée ; confirmation générique validée par le propriétaire sur S24 et signature reçue par Companion. Aucune opération exécutée. Préparation et demande d’ouverture 879 ms, retour avec geste humain 6 144 ms. Preuve canonique : ui-playbooks/confirmations/ACCEPTANCE.md. Paiement spécifique et étape bancaire non qualifiés par ce test.

## Reprise Topnet V1 — source 3 octobre 2026
Le Payment Core distingue désormais l'unique soumission financière (`executorAttempts <= 1`) d'une unique continuation bancaire (`bankResumeAttempts <= 1`). Une demande en `requires_bank_action` conserve uniquement des références de corrélation non sensibles ; un redémarrage avant reprise peut conserver cet état, tandis qu'une interruption pendant la reprise devient `effect_unknown` et n'autorise aucun rejeu.

La continuation exige une seconde confirmation native `payment.bank_2fa`, liée au même requestId, au fournisseur, à la référence et au montant. Cette preuve est à usage unique et ne peut pas autoriser un nouveau FORM1. L'activité Android sait enchaîner vers cette seconde confirmation lorsque le backend retourne `requires_bank_action`.

Les paiements réels restent désactivés. Aucun code OTP/2FA bancaire n'est lu, injecté ou soumis par ChatGPT/Companion dans ce lot. ClicToPay/SMT reste en découverte structurée pour FORM2 et le reçu positif ; l'activation Topnet exige une recette E2E physique distincte.
