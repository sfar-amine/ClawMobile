## Résumé

<!-- Quoi et pourquoi. Lot (ex. R11) et contrat lié. -->

## Règles de livraison (AGENTS.md) — cocher ou expliquer

- [ ] Fixtures réelles capturées sur le S24 (provenance indiquée) ; source de vérité runtime confirmée sur le S24
- [ ] Budget de temps par route, testé avec latence réaliste
- [ ] Volumes S24 réalistes dans les tests
- [ ] Aucun appel Gateway par ligne de liste
- [ ] Nouvelles routes ajoutées à `installer/termux-lite/companion-acceptance.py` (lecture + budget, ou refus sans en-tête propriétaire)
- [ ] Nouveaux tests inscrits dans `.github/workflows/ci.yml`
- [ ] Capability : `samantha.app.…` déclarée dans le registre, ou route listée dans `NO_CAPABILITY` avec sa raison, ou sans objet
- [ ] Parcours de paiement non modifié ; aucun nouveau store/registre/routeur/scheduler/démon
- [ ] Aucun secret (jetons, cookies, `.env`, OTP, paiement, e-mails de compte) ; exemples nettoyés

## Vérification

<!-- Commandes lancées et résultats. -->

## Retour arrière

<!-- Revert de cette PR, ou procédure. Le déploiement S24 reste fait par Claude via companion-deploy.sh. -->
