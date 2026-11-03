# Tri des PR historiques Chantier1 —25/10/2026

Comparaison : `sfar-amine/samantha-core`, remote `origin`, cible active vérifiée par le parent `3bed0f05f33be999706e3cd978ef819f7414bc10` (reçu S24 `companion-20261025T123328`).

Le comptage GitHub actuel diffère de la spécification : **10 PR ouvertes**,4 déjà fusionnées,14 numéros dans la plage #382–#395. Tous les14 heads exacts sont ancêtres de la cible active. Les fonctions/propriétaires ajoutés et leurs artefacts de test sont encore présents. Les PR restées ouvertes sont des branches empilées intégrées par les PR de synchronisation #388/#391 puis #396. Les fusionner à nouveau serait inutile.

**Disposition : fermer les10 PR ouvertes comme déjà intégrées ; garder les4 fusionnées.** Aucune clôture effectuée par cet agent. Aucune branche supprimée. Le changement de cible sémantique est traité par L2/L3, pas en réimportant les anciens heads.

|PR|État GitHub|Head exact|Décision|Contenu et traitement refonte|
|---|---|---|---|---|
|#382|open|`148dbff8c905f6b0683848defd0bf1f8ff3947d0`|Fermer : déjà intégrée|Contexte MCP client transporté comme donnée non fiable, schéma fermé et provenance. Préserver la séparation provenance/autorité dans la parité MCP L3 ; remplacer seulement le chemin sémantique dédié.|
|#383|open|`ef970c158c842901ddcba8d9ca5176c31fd48091`|Fermer : déjà intégrée|Port sémantique chargé en processus et transport privé stdin. Le port de l’interprète dédié est supprimable à L3 après recette ; les gardes IPC/confidentialité utiles restent sur le propriétaire typé.|
|#384|open|`77d7f2718ffa02922bd9469ddc6603a07d3efb7c`|Fermer : déjà intégrée|Callback MCP read-only lié au reçu RemoteBridge, pas un exécuteur fourni par JSON. Préserver idempotence et liaison de reçu dans l’appel typé L3 ; supprimer la dépendance à l’interprète dédié.|
|#385|open|`ad1cac969e438b50f0d3d03edb5967bd751b3852`|Fermer : déjà intégrée|Admission du contexte privé MCP par le canal authentifié propriétaire. Préserver l’autorité serveur et la séparation contacts/propriétaire lors de L2/L3.|
|#386|closed|`abab1e307592ec2a6238f50b1b22f126453df4ff`|Conserver fusionnée|Preuve privée du propriétaire CI canonique. Conserver localci.py ; aucune nouvelle intégration.|
|#387|closed|`d7a67af7c173631d61f8ecfd43188fd0cd9d7d3a`|Conserver fusionnée|Mandat borné de livraison autonome chantier1. Historique conservé ; la refonte suit le mandat explicite d’Amine du25/10.|
|#388|closed|`45218a5d9aa0767d37268505f2507b0c4f34e9c6`|Conserver fusionnée|Intégration OAuth et fondations C1/C4/C5/C8/C12. OAuth conservé, aucune reprise brute de branche.|
|#389|open|`21a765cfd0077ba009e1a5de9ca1b3ea2e0b09fb`|Fermer : déjà intégrée|Maintenance CAS : ne réouvrir que son propre epoch. Protection transverse à conserver dans companion-deploy.sh, hors suppression de l’interprète.|
|#390|open|`6bae515e389e3b271170f643eab495b9706c59d1`|Fermer : déjà intégrée|Handoff natif Pulse lié au claim durable et au résultat T2. Salles Pulse natives explicitement hors périmètre de la refonte ; conserver ce propriétaire.|
|#391|closed|`b3744cd358752d81e3eb9c2437f23824d43f4d19`|Conserver fusionnée|Synchronisation finale des propriétaires C1 et OAuth. Intégration effective, aucune fusion supplémentaire.|
|#392|open|`9ce1897938850c95716cd181271733a850fadc73`|Fermer : déjà intégrée|Lecture native FAST via un propriétaire scoped fermé et causes d’échec typées. Préserver les salles Pulse et leurs causes honnêtes ; ne pas supprimer cette admission avec l’interprète owner.|
|#393|open|`b15aa18c428acbefce06aa8a56deea42fa19a04d`|Fermer : déjà intégrée|Service Pulse MCP limité, porté par admission authentifiée. Préserver la frontière d’accès ; adapter la parité typée sans retirer le scope.|
|#394|open|`85570486beb5902d78b81339de4e25a97418e82f`|Fermer : déjà intégrée|Lecteurs de contexte natifs vérifiant l’autorité Contacts courante. Conserver les lecteurs et l’isolation ; L2 ne doit pas injecter le socle d’Amine aux contacts.|
|#395|open|`98f9271a5f471e9ae2fbf2f90526af28d4e8a5fd`|Fermer : déjà intégrée|Correction SecretRef du native agent-exec par scope auth, avec rollback. Conserver l’isolation runtime et la correction auth ; aucun partage d’état d’exécution.|

## Preuve et limites

Chaque fichier `c1-pr-details/N.json` conserve le snapshot GitHub et le diff par fichier. `c1-triage.json` conserve les14 résultats d’ascendance, premières intégrations et artefacts retenus. Contrôles source, sans lecture de secrets, sans effet métier. La présence source n’est pas une nouvelle recette live. Aucune CI, fusion, activation, clôture de PR ou suppression de branche effectuée dans ce tri.

Les14 résultats de `git merge-base --is-ancestor HEAD_PR 3bed0f05f33be999706e3cd978ef819f7414bc10` ont retourné0. Les marqueurs des fonctions ajoutées par les10 PR ouvertes sont présents sur cette cible.

Points à préserver lors des suppressions L3 : OAuth et provenance MCP, autorité serveur, idempotence RemoteBridge, CAS maintenance, scopes Pulse natifs/Contacts, SecretRef scoped. Seuls les chemins de décision owner obsolètes doivent disparaître.

## Exécution par Codex

Les10PR ouvertes ont été fermées via GitHub PATCH, chacune avec son head exact, la preuve d’ascendance et le reçu actif cités dans sa description. Leurs branches sont conservées. Reçus privés : c1-closure-receipts.json. Ceci clôt le tri historique de L0, pas la recette voix ni le lot entier.
