# Plugin : fixture de l'outil téléphone avec les réglages classiques — 31 octobre 2026

La PR playbooks sfar-amine/samantha-ui-playbooks#372 ajoute huit réglages directs à `samantha_device_assistance` : volume, luminosité, sonnerie, économie d'énergie, Bluetooth, réactivation du Wi-Fi, ouverture d'appli et capture d'écran. Le plugin n'a rien à changer dans son code : l'outil est déjà déclaré dans `contracts.tools` (#489) et visible directement.

Changements :
- `fixtures/playbooks-2026-10-31-device-typed-tool/device-assistance-tool.json` est régénérée par `project_tools` sur le head de #372 : 19 actions, dont 13 directes.
- `scripts/test-typed-device-direct.cjs` vérifie qu'aucune des 13 actions directes n'est marquée « récapitulatif puis confirmation ».
- Le plafond de la surface directe du prompt passe de 32 000 à 34 000 caractères (32 725 mesurés).

Retour arrière : revert, sans effet de déploiement (fixture et test seulement).
