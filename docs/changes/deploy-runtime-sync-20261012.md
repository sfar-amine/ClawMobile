# Déploiement : une seule version sur tout le S24 (12/10/2026)

## Incident
Le Companion était déployé (`1d7676ca`), mais la passerelle WhatsApp chargeait toujours la copie du plugin du 11/10 (`~/.openclaw/extensions/openclaw-plugin-mobile-ui`). Elle appelait aussi le `model-fast-path.py` de la release Tier0 de 10:34. Résultat : la pièce Pulse de Sadok a été servie par le modèle, qui a inventé un état de projet. Les correctifs du chemin rapide n'étaient pas actifs sur WhatsApp depuis le 11/10, y compris pour le propriétaire.

## Changement
- `installer/termux-lite/runtime-sync.sh <commit>`, appelé par `companion-deploy.sh` après la recette et par le retour arrière. Il réutilise les propriétaires existants :
  - plugin de la passerelle : `clawmobile_install_plugin` (`lib.sh`, forcé), puis redémarrage propre par `POST /v1/runtime/restart` et attente de `/v1/control/health?contract=2` ;
  - release Tier0 : `install-tier0-control.py --apply` (package, promotion, période d'observation, retour à la dernière version saine), puis `tier0-control.py prune --keep 10` ;
  - outils : `~/.openclaw/tools/companion-deploy.sh` et `companion-acceptance.py`, remplacés de façon atomique.
- Sans changement, rien n'est refait et la passerelle n'est pas redémarrée.
- Le reçu `~/.openclaw/deploys/companion-*.json` gagne le champ `runtime`. Un écart restant fait échouer le déploiement (`runtime_sync_failed`) et déclenche le retour arrière.

## Tests
`installer/termux-lite/test-runtime-sync.py`, inscrit dans la CI. Il couvre quatre cas :
- copies périmées amenées au commit ;
- deuxième passage sans effet ;
- release restée sur un autre commit : échec ;
- checkout sur un autre commit : refus avant toute copie.

## Retour arrière
Revenir sur ce commit. Les copies se mettent alors à jour comme avant, par `run.sh` et `install-tier0-control.py` à la main.
