# QA64 Q12 — protéger une campagne contre un déploiement

Le déploiement reprend le verrou canonique `~/.openclaw/deploys/companion-deploy.lock` en exclusif. Une campagne QA peut le tenir en partagé de son admission à sa fin de nettoyage (propriétaire `qa_testing`, playbooks #201). Il n'y a ni deuxième verrou ni lecture concurrente du fichier de campagne côté déploiement.

L'acquisition attend au plus 10 secondes par défaut, réglables par `COMPANION_DEPLOY_LOCK_WAIT_S` entre 0 et 600 secondes entières. Tant que le verrou est occupé, aucun fetch, compilation, arrêt de processus ou redémarrage ne commence. À expiration, le script termine avec le code 3 et la cause `deploy_lock_busy`, sans programmer de relance. Le message ne prétend pas distinguer une campagne d'un autre déploiement. Une erreur d'ouverture ou de `flock` refuse aussi le déploiement. Le reçu canonique reste écrit après acquisition exclusive ; aucun reçu concurrent n'est ajouté pendant qu'un autre déploiement écrit le sien.

## Source et tests

Capture en lecture seule du S24 du 18/10/2026, runtime `edb6238449bf8754e94fa2b91de78edd52ccbc19` : chemin du verrou, mode 0600, source de déploiement et prise en charge de `flock -s`/`-n`. Seule cette liste blanche est versionnée dans `openclaw-plugin-mobile-ui/fixtures/qa/deployment-lock-s24-20261018.json`. Aucun verrou réel n'a été acquis pendant la capture, aucune campagne ni action UI exécutée.

`installer/termux-lite/test-qa-deploy-protection.py`, inscrit dans `.github/workflows/ci.yml`, teste de vrais verrous locaux dans des répertoires temporaires : campagne partagée, déploiement exclusif, deux campagnes, libération pendant l'attente, expiration sans relance, budgets invalides et erreur de flock. Les commandes à effets sont des pièges locaux ; le seul chemin admis s'arrête au préflight existant batterie/mémoire. Les neuf tests ajoutés tournent en moins de trois secondes, sans réseau ni téléphone. Les tests existants de préflight et de racine sont conservés.

Aucune nouvelle route ni capability : ce point étend le propriétaire de déploiement existant, réservé à Claude. Pas de changement du paiement, de la voix ni de l'assainissement de l'environnement hérité (décision D).

## Recette après fusion et épinglage par Claude

Dans la recette Q12 bornée (3 cas × 15 étapes, 10 minutes, une relance d'environnement au plus), montrer qu'une campagne détenant le verrou partagé empêche le déploiement, puis que sa fin de nettoyage libère l'exclusif. Un appareil verrouillé, occupé ou injoignable donne BLOCKED et sa cause, sans boucle d'essais. Cette PR ne revendique aucune recette physique.

## Retour arrière

Revenir sur ce changement rétablit le refus immédiat du déploiement en cas de verrou occupé. Le chemin, le format des reçus et le propriétaire du verrou ne changent pas. La protection partagée de QA reste compatible avec le refus immédiat antérieur.
