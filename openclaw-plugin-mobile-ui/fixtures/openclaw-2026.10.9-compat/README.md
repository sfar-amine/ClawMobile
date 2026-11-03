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

Jeu `gateway-prep-stages` (préparation du 01/11/2026, `npm pack openclaw@2026.10.9` dans le conteneur Claude Code,
archive sha256 `43c61a00ef2c73416a072a7216cb3be80555d6740199f07194da2714283b04ab`, extraction ciblée de `dist/`) :
`openclaw-tools-CSSYZDKR.mjs.gz`, `tools-DQdRObqo.mjs.gz` et `attempt-system-prompt-prepare-ChKsbjSh.mjs.gz` sont les
modules publics, à l'octet près, que vise la variante `2026.10.9` de ce jeu. En 2026.10.9 la préparation du system
prompt a quitté `builtin-openclaw` pour `attempt-system-prompt-prepare` et `setup.prepStages` y devient optionnel (le
tour worker n'en passe pas). Le tracker `dist/stage-timing-BUG4Fnsv.mjs` de 2026.10.9 a les mêmes octets (sha256
`1d8cfb8d…`) que la capture S24 2026.9.6 de `../s24-2026-10-26-gateway-prep-stages/`, réutilisée telle quelle.
`gateway-prep-stages-harness.cjs` n'est **pas** une capture : c'est le harness écrit pour
`installer/termux-lite/test-gateway-prep-stages-1009.py` ; il exécute dans une VM les corps publics originaux puis
patchés avec des dépendances inertes (aucun import du SDK, aucun réseau, aucun modèle). Empreintes relevées en lecture
seule le 01/11 sur le candidat isolé du S24 (`~/.openclaw-android/staging/oc-global`) : identiques aux trois modules npm
(`f7f6b3b4…`, `de48b6fa…`, `99bb65a4…`) et au tracker (`1d8cfb8d…`).

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

Participant de session (01/11) : `session-accessor-C3ljJ974.mjs.gz` vient de `openclaw@2026.10.9` (flux du tarball npm
`openclaw-2026.10.9.tgz`, conteneur Claude Code), identique à l'octet au fichier du candidat S24 (SHA-256 `c000b950…caa34`).
Il porte la variante 2026.10.9 de l'entrée « participant natif » du jeu `memory-retrieval-warm` : même ancre qu'en
2026.9.6, mais avec `withOpenClawAgentDatabaseRuntime`, seule fonction d'admission de base importée par ce module.

Contrat de profil de modèle (01/11/2026) : la variante 2026.10.9 de `model-flow-selection` exporte aussi
`MODEL_PROFILE_CONTRACT_VERSION` depuis `dist/embedded-agent-DoEPu8ye.mjs`, comme `dist/setup-B7DuERIi.mjs` en 2026.9.6 ;
le propriétaire des métadonnées de session du plugin le lit là (`openclawSdkVersions.ts`). L'ancien résultat corrigé
(`b8062e79…`) est déclaré en `predecessors` : un candidat déjà corrigé passe au nouveau par ses octets d'origine.

Jeu `startup-triage-optout` (même archive npm, 01/11/2026) : `triage-failure-DoR3aje_.mjs.gz` (sha256 `a19382f0…e8ca746`,
identique sur le candidat isolé du S24) porte `triageAfterFailure`, que vise la variante 2026.10.9.
`triage-failure-8uvnbYn8.mjs.gz` (sa réexportation) et `run-HO6sETAH.mjs.gz` (sha256 `692c655a…`, identique sur le
candidat) prouvent que l'échec final du démarrage et l'échec d'une relance en processus (`onRestartStartupFailure`)
passent tous les deux par cette fonction. `startup-triage-optout-harness.cjs` n'est **pas** une capture : c'est le
harness écrit pour `installer/termux-lite/test-startup-triage-optout.py`, qui exécute le corps public original puis
patché dans une VM avec des dépendances inertes (2026.9.6 et 2026.10.9).

Proxy de sortie des secrets (01/11/2026) : `ca-D3c9PAvv.mjs.gz` (sha256 `63687cc6…5f5f`) et
`resolve-system-bin-COKBgJV4.mjs.gz` (sha256 `0c1f6ad9…9a17`) viennent de `openclaw@2026.10.9` (archive npm sha256
`43c61a00…04ab`, conteneur Claude Code). `ca-D3c9PAvv.mjs` est identique à l'octet au fichier du candidat S24
(`upgrade-rehearsal/live` et `oc-global`). Le jeu `android-fs-compat` vise `ca-D3c9PAvv.mjs` : il y fait chercher
`openssl` aussi dans `/data/data/com.termux/files/usr/bin`. `resolve-system-bin-COKBgJV4.mjs` n'est pas modifié ; le
test l'exécute tel quel avec le module CA, avant et après le correctif.

Ouverture de session sans module WhatsApp (02/11/2026, même archive npm `openclaw@2026.10.9`, sha256 `43c61a00…04ab`,
conteneur Claude Code) : `string-coerce-1VuiLaaR.mjs.gz`, `string-normalization-D6DKCpwE.mjs.gz`, `regexp-BZyMFTlj.mjs.gz`,
`glob-pattern-DuaaJ-nB.mjs.gz`, `tool-policy-shared-CNWjndK7.mjs.gz`, `tool-grant-allowlist-m1tXxJWt.mjs.gz` et
`manifest-tool-availability-DJlsKWK1.mjs.gz` sont les modules publics, à l'octet près, qui portent les helpers de
`resolvePluginToolPluginIds` (`tools-DQdRObqo.mjs`, déjà présent ; sha256 `de48b6fa…`, identique à l'installation de
production du S24 relevée le 02/11). `plugin-tool-selection-harness.cjs` n'est **pas** une capture : c'est le harness
écrit pour `installer/termux-lite/test-session-open-plugin-tools.py`, qui exécute dans une VM ces corps originaux
(choix des plugins du registre d'outils d'un tour) ; seuls les prédicats installé/activé/plan de contrôle sont inertes
(tout plugin disponible, comme sur le S24 où les deux plugins se chargent).
