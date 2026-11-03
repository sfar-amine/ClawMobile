# Correctifs de compatibilité OpenClaw 2026.10.9 après la répétition du S24 — 1er novembre 2026

Constat (répétition isolée de la 2026.10.9 sur le S24, préproduction) :
- la Gateway ne démarre pas : `ERR_MODULE_NOT_FOUND` pour `dist/store-CGYBYVbs.mjs`, importé par
  `dist/runtime-fLuYb9ac.mjs`. La variante 2026.10.9 d'`agent-exec-auth-scope` avait gardé le chunk et la lettre de la
  2026.9.6 ; ce chunk n'existe pas dans le build npm 2026.10.9 ;
- `openclaw-plugin-mobile-ui` ne se charge pas : le chargeur de plugins copie les fichiers de plus de 64 Kio avec
  `clone: "auto"`, Android refuse FICLONE (EACCES) et `copyRootFileSync` de `@openclaw/fs-safe` lève
  `guarded synchronous file copy failed`.

Changements :
- `agent-exec-auth-scope`, variante 2026.10.9 : `import { s as getScopedAuthProfileEnv } from "./store-C7nkCeF3.mjs";`
  (dans ce build, `c` exporte `getScopedSharedAuthStore`). Empreinte corrigée `f2b33707…6efe`. La variante cassée
  (`7010667f…2858`) est épinglée en `predecessors` : un candidat déjà corrigé avec elle passe à la bonne variante, ou
  revient à l'original, via ses octets d'origine vérifiés.
- `android-fs-compat`, variante 2026.10.9 : `node_modules/@openclaw/fs-safe/dist/copy-root-file-sync.js`
  (`995884a1…8786` → `bd72128f…9e86`), `resolveCopyCloneMode(options.clone === "auto" ? "never" : options.clone, "never")`.
- Contrôle CI générique `installer/termux-lite/test-openclaw-compat-imports.py` : pour chaque jeu et chaque variante,
  tout `import … from "./X"` ou `export … from "./X"` ajouté par un remplacement doit viser un module présent dans les
  fixtures de la même version, et chaque nom lié (`{ a as b }` → `a`) doit être exporté par ce module, après le même
  correctif. Avec `OPENCLAW_COMPAT_ARCHIVE_DIR`, la cible est aussi cherchée à son chemin exact dans l'archive npm.
  Sur les manifestes de la base, il signale exactement l'import de `./store-CGYBYVbs.mjs` ; aucune autre variante n'est
  fautive (il manquait seulement deux modules importés aux fixtures, ajoutés).

Pourquoi « auto → never » plutôt qu'`EACCES` dans les codes de repli : dans `copy-root-file-sync.js`, la liste de codes
ne fait que classer l'erreur (`unsupported-platform` ou `helper-failed`) ; elle est levée dans les deux cas et le
chargeur ne réessaie pas. Ajouter `EACCES` ne corrigerait donc rien. Il faudrait écrire une nouvelle tentative dans une
copie gardée (identités, fichier provisoire, nettoyage), ce qui est plus risqué. Et `EACCES` signale aussi de vrais
refus de permission, qu'un repli masquerait. La correction choisie change seulement la politique, avant tout accès au
disque : `"always"` reste strict, `"never"` et la valeur par défaut ne changent pas, et tous les contrôles d'identité
restent. On ne perd rien sur Android, où le clone n'est jamais disponible. Dans `copy-file-input.js`, `EACCES` reste
dans les replis, car ce module a un vrai repli (copie JS).

Fixtures : `store-C7nkCeF3.mjs`, `hook-runner-global-Cn3xHNvt.mjs` (npm `openclaw@2026.10.9`) et `copy-root-file-sync.js`
(npm `@openclaw/fs-safe@0.26.0`) dans `fixtures/openclaw-2026.10.9-compat/`. `store-CGYBYVbs.mjs` et
`hook-runner-global-C81Znoo2.mjs` (npm `openclaw@2026.9.6`, identique au S24) dans `fixtures/openclaw-2026.9.6-compat/`.

Tests (CI) : `test-openclaw-compat-imports.py` (nouveau, inscrit), `test-openclaw-compat-variants.py`,
`test-agent-exec-auth-scope.py`.

Aucun effet sur la 2026.9.6 installée. Rien n'est déployé. Retour arrière : revert ; sur un candidat 2026.10.9, le retour
arrière du déploiement restaure les modules d'origine.
