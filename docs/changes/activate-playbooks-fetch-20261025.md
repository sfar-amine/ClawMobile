# Activation des playbooks : récupérer le commit fraîchement fusionné (25/10/2026)

## Constat (S24, 25/10)
`activate-ui-playbooks.sh 698322f7` (fusion de playbooks #312) a échoué avec `fatal: Needed a single revision` : le workspace `~/.openclaw/workspace/ui-playbooks` n'avait pas encore récupéré ce commit, et le script fait `git rev-parse --verify` sans fetch. L'activation a réussi après un `git fetch origin main` manuel.

## Changement
`installer/termux-lite/activate-ui-playbooks.sh` : si le commit demandé est absent, le script le récupère depuis `origin`, d'abord par son SHA, sinon par les refs par défaut, puis vérifie à nouveau. Un commit inconnu échoue toujours, sans changer l'instantané actif.

## Tests
`installer/termux-lite/test-activate-ui-playbooks.sh` (déjà inscrit en CI) couvre deux cas nouveaux :
- un commit poussé sur l'origine mais pas encore récupéré est récupéré puis activé ;
- un commit inconnu est refusé, et l'instantané courant est conservé.

Contrôle par mutation : sans le correctif, le test échoue.

## Routes, capacités
Aucune route ni capacité. Outil de déploiement des playbooks seulement.

## Retour arrière
Revert du commit, puis `companion-deploy.sh` du commit précédent, qui ramène les outils.
