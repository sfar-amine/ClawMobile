# Surface SDK OpenClaw par version — 2026.9.6 et 2026.10.9

`openclaw-2026.9.6.json` et `openclaw-2026.10.9.json` décrivent, pour chaque version épinglée, ce que la table
`src/companion/openclawSdkVersions.ts` peut importer :
- `plugin_sdk` : pour chaque sous-chemin `openclaw/plugin-sdk/<nom>`, la cible de la carte d'export du `package.json`,
  le SHA256 du fichier et la liste exacte des noms qu'il exporte (`null` : ce sous-chemin n'existe pas dans la version) ;
- `chunks` : SHA256 et exports des modules hachés qui portent le contrat de profil de modèle
  (`dist/setup-B7DuERIi.mjs` en 2026.9.6, `dist/embedded-agent-DoEPu8ye.mjs` en 2026.10.9), avant correctif.

Provenance : `npm pack openclaw@2026.9.6` et `npm pack openclaw@2026.10.9` dans le conteneur Claude Code le
01/11/2026. Empreintes des archives (identiques au registre npm) :
- 2026.9.6 : SHA256 `1a7355691bc0e605222ba818f1f72c1787253c78dfeb0df6be2086ec73b71e63` (celle déjà épinglée dans
  `ci.yml`), shasum npm `fc64ad772b885b2c923e373acf27fcd4347e84f4` ;
- 2026.10.9 : SHA256 `43c61a00ef2c73416a072a7216cb3be80555d6740199f07194da2714283b04ab`, shasum npm
  `12242823a04ad5d60b6b2f8947b0d74d20dd0b1d`, le paquet du candidat isolé du S24 (voir `../openclaw-2026.10.9-compat`).

Les fichiers ont été lus comme du texte (`scripts/qualify-openclaw-sdk.cjs`, fonctions `readPackage`/`exportNames`) ;
aucun code OpenClaw n'a été importé ni exécuté. Les SHA256 des modules hachés sont ceux de `original` dans
`installer/termux-lite/openclaw-compat/model-flow-selection.json`.

Aucune configuration, aucun transcript, aucun identifiant : seulement des noms d'exports publics.

La CI rejoue la même lecture sur l'archive entière (`scripts/openclaw-sdk-surface-ci.sh`, job `openclaw-sdk-surface`) ;
`scripts/test-openclaw-sdk-versions.cjs` exécute les chargeurs du plugin sur des paquets reconstruits depuis ces listes.
