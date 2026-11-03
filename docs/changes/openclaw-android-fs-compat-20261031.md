# Compatibilité Android des fichiers pour OpenClaw 2026.10.9 — 31 octobre 2026

Constat sur le S24 : `/proc/self/ns/pid` n'existe pas (ENOENT) et le bac à sable Termux refuse les liens physiques et les clones (EACCES). OpenClaw 2026.10 lit l'inode du namespace PID pour le verrou de la Gateway, publie ses fichiers « lien ou copie », ne se replie depuis un clone natif que sur ses codes listés et déplace les artefacts de migration par lien. Chacun de ces points échoue sur le téléphone : la Gateway ne démarre pas et la migration des sessions s'arrête.

Changement : un jeu épinglé `android-fs-compat` dans le propriétaire de compatibilité existant. Il est vide pour la 2026.9.6 installée. Pour la 2026.10.9, il porte 12 modules publics (dist OpenClaw et `@openclaw/fs-safe` 0.26.0) :
- `EACCES` rejoint les replis de copie ;
- les artefacts de migration sont déplacés par `rename` quand le lien est refusé ;
- le namespace PID est lu comme « unavailable ».

C'est le résultat, épinglé à l'octet près, du correctif amont d'openclaw-android (MIT, `openclaw-patch-hardlink.sh`). Celui-ci s'applique entièrement au candidat 2026.10.9 installé à part sur le S24 (18 corrections, aucun problème).

Branchement identique aux autres jeux : `runtime-sync.sh` (application, contrôle, redémarrage si appliqué), `gateway-start.sh` (propriété du checkout), retour arrière de `companion-deploy.sh`. Fixtures : les 12 modules d'origine (`fixtures/openclaw-2026.10.9-compat/`). Test : `test-openclaw-compat-variants.py`.

Aucun effet sur la 2026.9.6. Retour arrière : revert.
