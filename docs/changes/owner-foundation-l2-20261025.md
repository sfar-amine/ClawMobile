# L2 — contexte canonique injecté par le propriétaire

Le démarrage faisait relire les6fichiers communs. Le Companion et le hook SDK cacheable main partagent maintenant la projection bornée produite par les playbooks. Les skills restent standard, à la demande ; Contacts n'hérite ni du socle ni de nouveaux outils. `claw_context` livre une seule copie avec empreinte des octets et conserve l'acquittement explicite du consommateur.

Routes : `claw_context` existant ; NO_CAPABILITY, contexte propriétaire sans action métier. Aucune route, permission ou voie de paiement nouvelle. Architecture : ADR-20261025-owner-foundation. Drapeau d'hôte requis, aucune activation revendiquée.

Tests : `test-owner-foundation.cjs` et `test-mcp-foundation.cjs`, ajoutés auprès du bootstrap canonique dans ci.yml ; métadonnées SDK/skills réellement capturées sur S24 et enveloppes de transport explicitement rédigées pour les cas unitaires. Les tests bootstrap existants sont conservés. CI complète et recette3surfaces restent à faire après les portes L0/L1.

Retour arrière : désactiver le drapeau, Companion et playbooks précédents par companion-deploy.sh et activate-ui-playbooks.sh.

Revue de la clé de cache : les champs sha256/révision de mémoire ont été déplacés après le corps. Ils changent toujours avec la mémoire, sans modifier les premiers tokens des règles et descriptions de skills stables ; test de deux révisions distinctes ajouté. Aucun cache hit fournisseur n’est revendiqué avant la recette.

Intégration : merge normal de Core420 d33ac0ba, sans activation ni CI prématurée ; 422 final attendu avant le head de CI419. Le test existant owner-foundation vérifie aussi le chargeur d’environnement canonique avec un fichier entièrement rédigé pour le test : flag persistant0/1 et priorité de la valeur héritée. Aucun .env du runtime n’est lu. La procédure publique fermée figure dans les playbooks, docs/07-engineering/context-foundation.md ; elle impose un seul drapeau persistant et la vérification de ce seul nom dans Gateway/Companion.

Correction de parité voix : la fondation commune ne doit pas supprimer le bloc VOICE_CONTEXT que le lecteur propriétaire injectait déjà en voiceDelegation. Ce bloc spécifique reste lu par le même lecteur borné, seulement sur cette surface, avec son avis VOICE_TURN. Le socle commun demeure identique ; aucun nouveau store ou droit. Test de non-régression inscrit dans owner-foundation, en attente du build intégré. Les quatre assertions du chargeur hôte ont été exécutées séparément et passent (preuve l2-core-host-loader-focused.log).
