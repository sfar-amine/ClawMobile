# SDK OpenClaw : table de versions 2026.9.6 / 2026.10.9 — 1er novembre 2026

Étape 1 de la montée OpenClaw 2026.9.6 → 2026.10.9. Les trois chargeurs du SDK installé (transport des tours owner, métadonnées de session des flux de modèle, propriétaire Gateway officiel) acceptaient seulement la 2026.9.6 et importaient `plugin-sdk/config-runtime` et le module haché `dist/setup-B7DuERIi.mjs`. Les deux ont disparu en 2026.10.9 : sur le candidat, chaque tour owner échouerait en `owner_transport_version_unsupported`.

Une seule table, `src/companion/openclawSdkVersions.ts`, associe maintenant chaque version épinglée à ses sous-chemins et à ses symboles :
- 2026.9.6 (production) : mêmes sous-chemins, même module de contrat, même ordre d'import qu'avant ;
- 2026.10.9 (candidat, archive npm publique) : `getRuntimeConfig` vient de `runtime-config-snapshot`, `resolveConfiguredSecretInputWithFallback` de `secret-input-runtime`, `coerceSecretRef` de `secret-ref-runtime`. `loadConfig` n'existe plus ; `getRuntimeConfig(options)` appelle le même `loadConfig(options)` dans les deux versions. Le contrat de profil de modèle est lu dans `dist/embedded-agent-DoEPu8ye.mjs` ;
- toute autre version reste refusée avant le premier import. Le dépôt de médias QA reste refusé en 2026.10.9 tant qu'il n'est pas qualifié.

La variante 2026.10.9 de `model-flow-selection` déclarait `MODEL_PROFILE_CONTRACT_VERSION` sans l'exporter : le contrat aurait valu 0 et les flux de modèle auraient été refusés. Elle l'exporte maintenant. L'ancien résultat corrigé est déclaré comme prédécesseur, si bien qu'un candidat déjà corrigé passe au nouveau correctif sans intervention.

CI :
- nouveau job `openclaw-sdk-surface`, avec une étape par version (paramètre ; `localci.py` n'a pas de matrice). Chaque étape vérifie le SHA256 de l'archive npm et n'en extrait que `package.json`, les façades `plugin-sdk` et les modules de `model-flow-selection`. Elle applique ce jeu avec son propriétaire, puis contrôle chaque ligne de la table par lecture de texte ;
- `test-openclaw-sdk-versions.cjs` est ajouté au job principal ;
- le job `p1-isolated-gateway` (SDK 2026.9.6) est inchangé.

Fixtures : `fixtures/openclaw-sdk-surface/`. Elles contiennent les cartes d'export, les listes d'exports et les SHA256 lus dans les deux archives npm (`npm pack`, le 01/11). La provenance est dans le README.

Reste bloqué en 2026.9.6 (refus explicite sur 2026.10.9) : transcription des mémos (nouveau reçu de qualification), synthèse Gemini publique, fournisseur Parallel Free, dépôt de médias QA, `gateway-secretref-exec.sh` (module haché), jeu `gateway-prep-stages` (sans variante 2026.10.9). Les imports réels et le démarrage du Gateway 2026.10.9 demandent Node 24.22.1+ ou 26.12.1+ : ce sont les étapes 3 et 4.

Retour arrière : revert. La production 2026.9.6 charge les mêmes modules qu'avant. Un candidat 2026.10.9 déjà corrigé avec cette variante doit d'abord être ramené par `--rollback`.
