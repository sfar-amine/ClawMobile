# OpenClaw 2026.10.9 — modules publics des correctifs de compatibilité

Fichiers `*.gz` (gzip -9, sans horodatage) : modules publics du paquet npm `openclaw@2026.10.9`, à l'octet près, que
visent les variantes `2026.10.9` des jeux `memory-retrieval-warm`, `native-turn-provenance`, `agent-exec-auth-scope`
et `model-flow-selection` (`installer/termux-lite/openclaw-compat/*.json`, clé `packages`).

Provenance : `npm pack openclaw@2026.10.9` dans le conteneur Claude Code le 31/10/2026. Le même paquet a été installé
sur le S24 en candidat isolé (`~/.openclaw-android/staging/oc-global`, `npm install -g --prefix … --ignore-scripts`,
production non touchée). Le jeu `model-flow-selection` y a été reconstruit avec les mêmes ancres et donne le même
résultat (empreinte de la liste de fichiers `514eed9e…` des deux côtés). Les cinq modules corrigés s'y importent
avec leurs dépendances réelles (`hooks`, `context-engine-maintenance`, `compact`, `embedded-agent`, `run-entry`).

Aucun transcript, aucune configuration, aucun identifiant : seulement du code public, sous licence OpenClaw.

WhatsApp : `connection-controller-CejM7bhn.mjs.gz` et `monitor-DVzumwCI.mjs.gz` sont les modules publics du paquet npm
`@openclaw/whatsapp@2026.10.9` (`npm pack`, même jour), plugin que OpenClaw installe à sa propre version ;
`server-runtime-startup-services-CSJSnUKS.mjs.gz` vient de `openclaw@2026.10.9`. Ils portent la variante 2026.10.9 du jeu
`whatsapp-network-recovery` : même correctif, ancres suivies là où l'amont a déplacé `heartbeatSeconds`,
`reconnectPolicy` et `keepAlive` sous `this.params` et fusionné la décision de reprise.

`@openclaw/fs-safe` : `copy-file-input.js.gz`, `publish-file.js.gz` et `copy-root-file-sync.js.gz` viennent du paquet npm
`@openclaw/fs-safe@0.26.0` (`npm pack`, archive sha256 `78da1512…3591`), dépendance exacte que `openclaw@2026.10.9` épingle
et qu'il installe sous `node_modules/@openclaw/fs-safe` ; le jeu `android-fs-compat` les vise à ce chemin.

Supplément du 01/11/2026 (répétition isolée de la 2026.10.9 sur le S24) : `npm pack openclaw@2026.10.9` refait dans un
dossier neuf, archive sha256 `43c61a00ef2c73416a072a7216cb3be80555d6740199f07194da2714283b04ab`, extraction ciblée.
- `store-C7nkCeF3.mjs.gz` (sha256 `e3305c23…4815`) : module que la variante 2026.10.9 d'`agent-exec-auth-scope` importe
  (`s` = `getScopedAuthProfileEnv` ; `c` y est `getScopedSharedAuthStore`). `store-CGYBYVbs.mjs`, importé par la première
  variante, n'existe pas dans cette archive (ERR_MODULE_NOT_FOUND au démarrage de la Gateway sur le S24).
- `hook-runner-global-Cn3xHNvt.mjs.gz` (sha256 `c53d7c43…6374`) : module que la variante 2026.10.9 de
  `model-flow-selection` importe (`n` = `getGlobalHookRunner`).
- `copy-root-file-sync.js.gz` (sha256 `995884a1…8786`) : copie synchrone gardée que le chargeur de plugins appelle avec
  `clone: "auto"` au-delà de 64 Kio ; visée par `android-fs-compat`.

Les modules importés ne sont pas modifiés : ils servent au contrôle `installer/termux-lite/test-openclaw-compat-imports.py`
(chaque import introduit par un remplacement vise un module et une lettre d'export réels de la même version).

Contrat de profil de modèle (01/11/2026) : la variante 2026.10.9 de `model-flow-selection` exporte aussi
`MODEL_PROFILE_CONTRACT_VERSION` depuis `dist/embedded-agent-DoEPu8ye.mjs`, comme `dist/setup-B7DuERIi.mjs` en 2026.9.6 ;
le propriétaire des métadonnées de session du plugin le lit là (`openclawSdkVersions.ts`). L'ancien résultat corrigé
(`b8062e79…`) est déclaré en `predecessors` : un candidat déjà corrigé passe au nouveau par ses octets d'origine.
