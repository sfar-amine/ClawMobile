# R8 — apprentissage propriétaire, PR draft

Ajoute le parcours learn confirmé et les lectures de candidats du propriétaire recordings. submitIntent réutilisé dans skill-learning avec option interne empêchant les chemins fast-path et auto-skill ; aucun appel direct Companion à la promotion, l’installation ou l’exécution d’une skill. Le paiement est exclu en préflight par le resolver canonique et les gardes globales existantes.

Validation locale : build,54 assertions parcours/candidats/HTTP/vrai submitIntent/consume cryptographique,22 assertions de garde v2,2 tests du vérificateur acceptance. Toutes les commandes du ci.yml de base passent ; les trois suites R8 sont maintenant inscrites dans ci.yml, avec toutes les étapes de base conservées. Les fixtures sont synthétiques, sans S24. La signature corrompue après status est refusée avant soumission. Le plus récent des601 dossiers est trouvé même lorsque son mtime est ancien.

Livraison volontairement bloquée : captures S24 P0-2, schéma/volumes/latences réalistes manquent. Budget lecture2s provisoire ajouté à companion-acceptance.py. La boîte à outils du modèle Gateway est générale : le prompt fixe interdit la promotion, et son confinement global n’est pas prétendu ; le contrat demandé de prompt fixe et sans appel direct Companion est respecté. merge_eligibility:blocked ; la gate de livraison refuse donc intentionnellement la fusion. Cette PR est une préparation reviewable, aucune qualification ni activation annoncée.

Contrat : docs/work/samantha-runtime/contracts/r8.md. Claude complète les preuves, relit, puis fusionne et déploie uniquement via companion-deploy.sh. Aucun merge ou déploiement Codex. Retour arrière : revert de la PR R8.

Revue26 : runtime0bf30ab intégré, CI R8 inscrite, manifeste G2 et routes acceptance de base conservés. Budgets P0 et captures restent manquants ; draft et gate bloquée conservés.
