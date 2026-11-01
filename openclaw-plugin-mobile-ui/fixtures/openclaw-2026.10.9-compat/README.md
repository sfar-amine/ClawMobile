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

Participant de session (01/11) : `session-accessor-C3ljJ974.mjs.gz` vient de `openclaw@2026.10.9` (flux du tarball npm
`openclaw-2026.10.9.tgz`, conteneur Claude Code), identique à l'octet au fichier du candidat S24 (SHA-256 `c000b950…caa34`).
Il porte la variante 2026.10.9 de l'entrée « participant natif » du jeu `memory-retrieval-warm` : même ancre qu'en
2026.9.6, mais avec `withOpenClawAgentDatabaseRuntime`, seule fonction d'admission de base importée par ce module.

Contrat de profil de modèle (01/11/2026) : la variante 2026.10.9 de `model-flow-selection` exporte aussi
`MODEL_PROFILE_CONTRACT_VERSION` depuis `dist/embedded-agent-DoEPu8ye.mjs`, comme `dist/setup-B7DuERIi.mjs` en 2026.9.6 ;
le propriétaire des métadonnées de session du plugin le lit là (`openclawSdkVersions.ts`). L'ancien résultat corrigé
(`b8062e79…`) est déclaré en `predecessors` : un candidat déjà corrigé passe au nouveau par ses octets d'origine.
