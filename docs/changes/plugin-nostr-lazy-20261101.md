# #126 : Gateway bloquée au premier tour après un redémarrage — 1er novembre 2026

Profil CPU sur le S24, le 01/11 à 12:56, après un redémarrage volontaire de la Gateway. Le premier tour du propriétaire a occupé le thread principal pendant environ 90 s :

- `eventLoopDelayMax` de 46,6 s ;
- WhatsApp coupé en 408 ;
- démarrage du tour 91 s après la demande.

44 s de ce temps se passent sous le premier import de `loadInstalledSessionStoreSdk`. OpenClaw y capture la « génération » du plugin : il recopie fichier par fichier chaque dépendance **déclarée** du plugin (`capturePluginDependencies`, 27 s), puis la revérifie (`verifyPluginSourceInputs`, 14 s). Les appels système `lstat`, `read` et `open` dominent.

Sur 635 fichiers de dépendances déclarées, 616 appartiennent à `nostr-tools` et à ses paquets @noble et @scure. `ws` n'en a que 19. Le transport nostr n'apparaît dans aucun journal du jour.

Correctif :

- `nostr-tools` devient une dépendance de développement. Elle reste installée sur le S24, car `lib.sh` lance `npm install --include=dev`, mais OpenClaw ne la capture plus.
- `companion/nostr.ts` la charge au premier appel nostr, par un `require` calculé : l'analyse des références d'OpenClaw ne la voit pas au chargement du plugin.

Ce qui reste est mesuré après déploiement avec le même profil : le chargement paresseux du registre de plugins d'OpenClaw (environ 15 s) et la vérification des fichiers encore capturés.

Retour arrière : revert, puis `companion-deploy.sh`.
