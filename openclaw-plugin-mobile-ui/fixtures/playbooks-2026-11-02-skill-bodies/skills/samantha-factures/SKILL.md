---
name: samantha-factures
description: Consulter rapidement les factures en attente, impayés et restes dus STEG, SONEDE et Topnet pour Amine, avec lecture HTTPS directe, montants exacts et résultats partiels explicites.
---
# Factures en attente — lecture propriétaire
Pour Amine uniquement, jamais pour divulguer ses comptes à un autre contact. Utiliser le checkout local ; ne pas attendre Git ni rediscover les sites.

## Entrée opérationnelle : l'outil typé d'abord
Appeler directement l'outil typé, présent dans tes outils (sinon `tool_search` avec une seule `query`, jamais de `limit` au niveau d'un lot `queries`) :
- aucun fournisseur ou plusieurs fournisseurs nommés → `samantha_utility_billing` avec `{"action": "billing.unpaid", "params": {}}`, un seul appel ; restituer seulement les fournisseurs demandés ;
- un seul fournisseur nommé → `samantha_steg`, `samantha_sonede` ou `samantha_topnet` avec `{"action": "billing.unpaid", "params": {}}`.

L'outil passe par le Capability Graph et le runtime épinglé, et rend le reçu. Pas de shell, pas de second outil en parallèle (un verrou refuse deux consultations simultanées : `billing_check_already_running`).

Repli shell, seulement si aucun outil typé n'est disponible : le runtime épinglé, jamais le checkout `workspace/ui-playbooks`, qui peut retarder sur la version active (S24 30/10 : ce checkout ancien a rapporté `login_form_changed` pour la maintenance Topnet, que la version active classe `provider_maintenance`).
```bash
cd /data/data/com.termux/files/home/.openclaw/runtime-ui-playbooks/current
python3 -m billing.cli check --json
```
Un fournisseur précis : ajouter `--provider steg`, `--provider sonede` ou `--provider topnet`. Sans fournisseur demandé, consulter les trois dans le même appel canonique; le runtime exécute les branches indépendantes en parallèle et Samantha restitue uniquement le résultat consolidé terminal. Une cible explicite utilise uniquement son `--provider` et ne lance pas le consolidé. Pour une demande conversationnelle live, lancer ce point d'entrée canonique directement : ne pas redécouvrir les sites et ne pas tenter d'abord les scripts Node sous `direct-runtime/`. Ne pas utiliser les anciens adapters à fetchers simulés comme accès réel.

## Compréhension des demandes et fournisseurs
« Mes factures » signifie les impayés/restes dus vérifiés. Un fournisseur nommé prime sur cette formule générique ; plusieurs fournisseurs explicitement nommés donnent exactement leur sous-ensemble : `python3 -m billing.cli check --provider topnet --provider steg --json`, sans SONEDE. Le Graph transmet la liste typée au point d'entrée existant ; ne pas lancer plusieurs appels indépendants ni créer un autre routeur.
« Combien à payer », « je veux savoir quelles factures payer », « avant de payer » et « comment payer » sont des lectures. Une instruction affirmative de paiement conserve `billing.pay` et son risque transaction ; une négation explicite ne l'autorise jamais. « Paie toutes mes factures » demande la sélection d'une seule facture, jamais un paiement groupé. Comprendre cet intent ne change aucune disponibilité fournisseur ni frontière d'autorisation.
Un détail utilise seulement les observations exposées par `--details`. Une demande d'historique payé ou de facture déjà payée ne se transforme pas en consultation d'impayés : signaler l'absence de source qualifiée. Une facture Orange n'est pas une facture Billing inventée ; la recharge explicite conserve son parcours existant. Cette évolution de compréhension reste en préparation source, sans activation ou preuve bancaire nouvelle ; voir [le contrat du lot](../docs/work/samantha-convergence/55_Billing_Intents_20261015.md).

## Réponse niveau 1
Donner oui/non lorsque la couverture permet de conclure, puis les factures identifiées et leurs restes dus, ou les soldes de référence explicitement signalés. Reprendre les montants, pas les recalculer en flottants. Le programme fournit des chaînes décimales TND à trois positions et des millimes entiers.
Règle B validée : uniquement impayés ou restes dus explicites. Le montant courant « à payer » STEG n'est pas un impayé à lui seul et n'est pas additionné aux arriérés. Un solde de référence n'est pas un nombre de factures ; respecter `pending_count=null`.
Si `coverage_complete=false`, conserver les résultats confirmés et citer le fournisseur en échec. Ne jamais remplacer un échec par zéro. `total_pending=null` signifie que le total global n'est pas établi. Une facture due ultérieurement peut avoir un reste positif : ne pas dire « en retard » depuis le seul statut impayé. La stabilité du fast path ne signifie pas disponibilité permanente des trois sites : un provider `context_blocked` reste une couverture manquante explicite pendant son indisponibilité, sans relancer les branches déjà vérifiées.

## Détail et échec
`--details` ajoute seulement les observations déjà lues, dont montant courant STEG séparé ; aucun PDF. `--exhaustive` sert à la recette des pages et compteurs, pas aux demandes normales.
Le client réutilise les accès protégés et n'appelle ni Chrome ni modèle. Une erreur réseau GET peut être retentée une fois ; pas de boucle de connexion. `billing_check_already_running` évite deux consultations concurrentes via le point d'entrée canonique.
Lire `ui-playbooks/billing/CONSULTATION.md` pour les contrats, preuves et limites. Une dérive de schéma requiert un diagnostic explicite et des tests avant promotion, pas une réécriture spéculative ni une autorisation globale.
Le programme ne paie rien et ne soumet aucun formulaire métier. Toute demande de paiement est un autre parcours, avec facture, bénéficiaire et montant vérifiés puis autorisation explicite.

## Suivi après paiement
Pour une facture exacte déjà identifiée, utiliser `python3 -m billing.cli payment-verify --provider topnet --invoice-input-stdin --json`. Passer sur le pipe privé un objet contenant exactement invoice_id, expected_amount_millimes et currency=TND. Ne pas passer de données carte et ne pas consigner la référence dans le shell ou Git. Une attente bornée est disponible avec --wait-seconds 60; pas de création d'ordre ni de rejeu du paiement.
Une facture soldée signifie uniquement que le fournisseur affiche zéro. Le paiement bancaire reste non attribué tant qu'une preuve de transaction manque. Rapporter la raison du résultat, sans transformer un impayé ou un timeout en autorisation de retenter. Pour les autres sites, un contrat distinct reste nécessaire. Voir PAYMENT.md.

## Configuration de carte demandée par Amine
Utiliser la saisie masquée locale `python3 ~/.openclaw/workspace/ui-playbooks/billing/card_setup.py --expected-last4 DERNIERS_4_CHIFFRES`. Ne jamais demander de numéro, expiration, cryptogramme ou code SMS dans un chat. Aucun enregistrement automatique depuis Chrome. Le stockage existant Claw reçoit numéro, expiration et nom. Amine autorise aussi le CVV enregistré séparément via --save-code; aucun code SMS conservé. Ce programme ne paie rien. Après saisie, le statut expurgé est disponible avec le runtime Node natif et `billing/direct-runtime/payment-card-cli.mjs status`. Ne pas lancer `get` sur le secret. Lire PAYMENT.md pour les limites.

## Recette explicitement demandée : message puis annulation
Après configuration de carte, proposer uniquement la commande locale `python3 -m billing.payment_acceptance --provider topnet --expected-last4 DERNIERS_4_CHIFFRES` depuis le checkout canonique. Le cryptogramme doit être configuré une fois par --save-code dans card_setup.py. La recette réutilise ensuite les références natives sans saisie. Un paiement direct sans SMS est possible; ne pas promettre une recette sans débit. Elle soumet une fois, observe le message en arrière-plan, demande l’annulation et relit la facture. Aucun code SMS n’est saisi. Ne jamais appeler directement le CLI Node interne : le contrôleur Python porte le verrou et le garde de non-rejeu du checkpoint engineering existant. Ne pas effacer ce garde pour retenter sans réconciliation explicite. L’implémentation est expérimentale; aucune recette complète avec carte réelle ni paiement réussi n’est encore confirmé. Voir PAYMENT.md.

Pour configurer uniquement le CVV demandé par Amine : `python3 ~/.openclaw/workspace/ui-playbooks/billing/card_setup.py --expected-last4 DERNIERS_4_CHIFFRES --save-code`. Un seul champ masqué, pas de valeur dans le chat. Contrôler ensuite payment-card-cli.mjs status : cvc_stored doit être vrai pour la carte attendue. Aucune recette réelle avant cette configuration; le mode SMS/annulation ne renseigne jamais le code bancaire.

## Demande de paiement quotidienne — cible sans terminal
« Paie ma facture » désigne le parcours de production décrit dans PAYMENT_JOURNEY.md. Ne jamais l’orienter vers payment_acceptance.py : cet outil de recette demande volontairement l’annulation. Les commandes Termux sont réservées à la configuration initiale et aux essais explicitement demandés; elles ne constituent pas le parcours produit livré.
Lire les factures par le point d’entrée canonique pour déterminer fournisseur, facture et montant exacts. Si `payment.owner_native` expose une route déterministe active pour le fournisseur demandé, déléguer le paiement à cette capability : le propriétaire autorise par biométrie locale, puis les éventuelles étapes OTP/3DS/banque restent humaines. Ne jamais remplacer une route owner disponible par un refus générique de paiement. Si aucun adaptateur transactionnel validé n'existe pour le fournisseur, signaler ce manque précis. Après toute action, vérifier les preuves sans nouvelle soumission.
Ne jamais annoncer un paiement réussi depuis la seule réception d’un message ou la seule disparition d’un impayé. Réutiliser les états vérifiés du contrat de résultat; conserver un résultat indéterminé lorsque les preuves manquent. Une nouvelle intégration doit établir ses propres contrats, sans copier la validation Topnet vers les autres sites.

## Résultat d’une transaction déjà effectuée
Si le contexte original contient la facture exacte, son montant, la devise, le checkout fournisseur et la session prestataire, utiliser payment-complete via billing.cli avec --invoice-input-stdin --json. Passer les cinq champs du contrat PAYMENT.md sur pipe privé; ne pas exposer les références dans les arguments ni inventer une session manquante. C’est uniquement une lecture après action bancaire du propriétaire. Aucun envoi de carte, nouveau checkout ou annulation.
Reprendre l’état et le motif projetés. Un rejet connu sans motif bancaire donne « paiement non abouti confirmé, motif précis indisponible ». Un retour non reconnu reste indéterminé. Ne jamais annoncer une réussite depuis une facture soldée seule : utiliser le résultat corrélé du PaymentRecord et le readback fournisseur exigés par `payment.owner_native`.

## Confirmation native commune
La capacité transversale `payment.owner_native` expose le client `payments.cli`; lire `payments/README.md` et `capabilities/howto/payment.owner_native.md`. Les commandes de préparation ne valent jamais autorisation : la biométrie Android est le geste propriétaire qui permet au moteur local de créer le PaymentRecord et d'effectuer au plus une soumission financière selon la route active. OTP/3DS/banque restent strictement humains. Topnet et Maxit disposent de contrats transactionnels distincts; une route désarmée ou indisponible doit être rapportée par son motif précis, jamais reformulée en interdiction générale des paiements.

La confirmation formelle commune est owner.confirmation (confirmations/README.md). Elle ne soumet pas de paiement et ne rend pas une opération automatiquement permise. payment.owner_native réutilise son écran, en conservant ses contrôles métier et un domaine de preuve séparé.
