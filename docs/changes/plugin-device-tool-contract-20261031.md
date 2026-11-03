# Plugin : outil téléphone déclaré dans contracts.tools — 31 octobre 2026

Deux déploiements du cœur 052d7b5a ont été annulés par le parcours `write_recap` (reçus `companion-20261031T145023` et `companion-20261031T152044`). Cause lue sur le S24 : la Gateway exige que chaque outil du plugin figure dans `contracts.tools` de `openclaw.plugin.json` ; `samantha_device_assistance` (ajouté par #486) n'y figurait pas. Avec 052d7b5a, la Gateway a refusé (« plugin must declare contracts.tools for: samantha_device_assistance ») et le cerveau a perdu tout le lot d'outils typés (102 → 97 outils catalogués, plus de `samantha_agenda`) : il a cherché, est passé par le shell et a posé une question au lieu du récapitulatif. Avec 510e1a61, l'outil non déclaré était seulement ignoré.

Changements :
- `samantha_device_assistance` ajouté à `contracts.tools`.
- `scripts/test-typed-device-direct.cjs` vérifie que tout nom de `DIRECT_TYPED_TOOLS` et tout descripteur typé renvoyé par la fabrique est déclaré dans le manifeste. Le test échoue sur le manifeste de 052d7b5a et passe avec ce changement.

Fixture : `fixtures/s24-2026-10-31-device-contract/` (journal Gateway et transcript, texte utilisateur retiré).

Retour arrière : revert, puis `companion-deploy.sh` du commit précédent.
