# R20 : façade de lecture Gateway en brouillon

Les routes /v1/files et /v1/files/content réutilisent les méthodes de lecture Gateway et un cache RAM borné. Le chemin HTTP cold répond warming ; listes limitées, projection sans racine, exclusions avant get, liaison canonique du run et garde paiement relue même sur cache hit. Le client existant reçoit une option stricte R20 seulement, qui borne les sorties et nettoie le groupe CLI au timeout.

Les quatre suites locales vérifient schémas publics 2026.9.6, HTTP/pagination/cache, confidentialité, bornes UTF-8/images et nettoyage réel d'un processus simulé. Aucun paquet propriétaire n'est exécuté et aucune qualification S24 n'est revendiquée.

La PR reste draft/non activable : captures installées et racine physique à qualifier, dépendance garde financier P2-b, navigateur propriétaire limité à 250 sans curseur, aperçus session limités à 256 Kio et liste blanche fallback absente. Les limites du contrat ne sont pas contournées.

Process PR #52 intégré (base85aeb07), AGENTS.md lu : NO_CAPABILITY temporaire et mapping canonique requis avant activation. Aucun nouveau code fonctionnel avant les captures S24 ; preuve runtime, latences réalistes, volumes et limite d’attente de 15 s restent bloqués. Retour arrière uniquement via le pipeline documenté après qualification.
