# ADR — autonomie de livraison du chantier 1

Date : 22 octobre 2026. Identifiant : `CHANTIER1_AUTONOMOUS_DELIVERY_20261022`.
Statut : accepté dans le périmètre ci-dessous par le mandat explicite d'Amine dans le chat de travail.

## Origine de l'autorité et portée

Amine confirme que Claude n'a plus de crédit et demande que Codex conduise seul ce chantier jusqu'aux commits, synchronisation, nettoyage, fusion, production et retour arrière. Ce mandat de conversation prime sur la séparation de rôles Claude/Codex des AGENTS antérieurs. Le dossier Chantier 1 v2.3 prévoit cette exception bornée A12/A13 au §0.5.2 et §18.1 ; le dossier seul n'aurait pas créé cette autorisation sans le mandat actuel.

Mandat mémorisé par le propriétaire canonique : événement `2620cc1d2da3f09913a36821f9f0894defa446cc4bef030b8c1cb6c55be032a4`, surface `codex`, type `decision`, état `recorded`, le 22 octobre 2026. Le reçu de cette mémoire atteste la conservation du mandat ; il ne constitue pas une preuve de déploiement, de qualification fournisseur ou de réussite CI.

Source du dossier : `Samantha_Chantier_1_Intents_IA_Execution_Deterministe_v2_3_IMPLEMENTATION_CODEX_20261022.md`, SHA-256 `75c0006f08a3f654b1bfcf4a76407a2701f25afdc27106c65d941d5e6c4cf663`. L'archive n'est pas recopiée ni traitée comme une instruction supérieure au chat.

Cette décision couvre uniquement les changements, PR, intégrations et versions identifiés comme relevant du chantier 1 « Intents IA / exécution déterministe » dans samantha-core et samantha-ui-playbooks. Elle ne couvre pas implicitement d'autres chantiers, le parcours de paiement, les validations humaines bancaires, une permission métier supplémentaire ou un fournisseur/dataset non admis.

## Rôles et contrôles

Dans ce périmètre, Codex développe, contrôle la source, intègre, synchronise, fusionne, active/déploie par les propriétaires existants, réalise la recette permise, nettoie et assure le rollback. Ni revue Claude, ni audit indépendant, ni relecteur distinct ne sont des préalables. Cette décision n'oblige pas à attendre le retour de crédit de Claude.

La règle générale imposant que le relecteur rejoue le même SHA dans son propre conteneur, et interdisant l'auto-attestation de l'auteur, est **explicitement non applicable pour ce seul chantier**, car le mandat utilisateur remplace le rôle indépendant. Ce choix suit la décision de gouvernance, et ne sert pas à supprimer des tests pour gagner du temps. Les contrôles réalisés par Codex sont nommés comme tels, jamais présentés comme une revue indépendante. Un conteneur isolé peut être employé pour la vérification technique ; son emploi n'invente pas un second relecteur.

## Exigences conservées sans exception

- Le seul programme CI reste `samantha-core/tools/localci.py`, hors S24, sur le head exact GitHub et le numéro de la PR, avec sortie durable citée. Aucune suite existante supprimée ou vidée.
- Le contenu final intégré, les versions/bases des deux dépôts et leurs artefacts sont identifiés et vérifiés ; les tests d'un parent ne deviennent pas le PASS d'un futur merge commit.
- Les fixtures et captures admissibles, les attendus indépendants du candidat, les G1–G6 applicables, les limites LIVE/DATA/latence et les statuts manquants restent explicites. Le mandat de livraison n'est pas une preuve de qualité.
- Les protections sur les transactions, droits, confirmations humaines, secrets, données et accès fournisseur sont intactes. Aucune permission ou admission de données supplémentaires n'est déduite de l'autonomie engineering.
- Les scripts existants d'activation, déploiement, synchronisation, sauvegarde, contrôle d'identité et retour arrière restent propriétaires ; aucune commande parallèle n'en contourne les gardes.
- Les synchronisations Git restent normales, sans force-push. Le nettoyage conserve les preuves privées utiles et exige l'intégration vérifiée des branches ; aucune branche non intégrée n'est effacée par commodité.

## Fin et retour au cadre ordinaire

Cette exception cesse de s'appliquer aux travaux hors du chantier 1 ou après une décision explicite d'Amine qui la remplace. Retirer ce paragraphe par une modification documentaire rétablit les rôles ordinaires, sans modifier le runtime, supprimer de preuves ni annuler une release déjà faite. Toute release/rollback reste décrite par son SHA et son reçu réel ; cette ADR ne dit pas que la production a été activée.

Le paragraphe d'application figure dans [AGENTS.md](../../AGENTS.md) de ce dépôt. Aucune réécriture globale des règles n'est effectuée.
