# OpenClaw 2026.10.9 — fonctions publiques des tests de comportement model-flow

Sources publiques du paquet npm `openclaw@2026.10.9`, lues comme du texte, pour les jambes 2026.10.9 de
`installer/termux-lite/test-model-flow-setup.cjs`, `test-model-flow-compaction.cjs` et
`test-model-flow-native-session.cjs` (argument `2026.10.9` ; sans argument, ces tests rejouent la capture S24 2026.9.6 de
`../s24-2026-10-25-model-flow-sdk`, inchangée).

Provenance : `npm pack openclaw@2026.10.9` dans un dossier temporaire neuf du conteneur Claude Code, le 01/11/2026.
SHA256 de l'archive `43c61a00ef2c73416a072a7216cb3be80555d6740199f07194da2714283b04ab`, le même que
`../openclaw-sdk-surface/openclaw-2026.10.9.json` et que le candidat isolé du S24 (`../openclaw-2026.10.9-compat`).
Extraction ciblée des seuls modules cités ci-dessous, puis suppression de l'archive. Aucun code OpenClaw n'a été importé
ni exécuté pour produire ces fichiers.

- `native-session-cas-snippets.json` : fonctions extraites de 14 modules hachés (chaîne de `patchSessionEntry` :
  projection publique, garde de commit externe, cœur `patchSessionEntryCore`/`patchSqliteSessionEntrySnapshot`, choix du
  writer, noyau worker `commitSessionEntryPatch`, `runOpenClawAgentWriteTransaction`,
  `runOpenClawAgentWriteWithYieldingAdmission`, contrôle `readUnchangedLifecycleTargetSnapshot` /
  `assertLifecycleTargetSnapshotUnchanged`). Pour chaque module : SHA256 et taille du fichier entier ; pour chaque extrait :
  marqueurs de début et de fin, ligne, SHA256. Les tests vérifient le SHA de chaque extrait avant usage.
- `model-ref-profile-BNjB2hED.mjs` (`splitTrailingAuthProfile`) et `fetch-request-authority-DJ_0g9EM.mjs`
  (`withGuardedFetchRequestAuthority`) : modules entiers, SHA256 dans `PROVENANCE.json`.
- `LICENSE.openclaw` : licence du paquet.

Les modules corrigés par `model-flow-selection` (hooks, embedded-agent, run-entry, compact, context-engine-maintenance,
config-contracts) ne sont pas recopiés : les tests les lisent dans `../openclaw-2026.10.9-compat` et vérifient les SHA
`original` et `patched` du jeu.

Les entrées/sorties restent rédigées et explicites dans les tests : une table SQLite minimale locale, des ports pour
l'écriture de ligne, la fusion d'entrée, l'identité de base et le transport worker (`patchSessionEntryInWorker` : lecture
sur la connexion du worker, préparation sur le thread principal, commit par le noyau ; clonage structuré entre les deux).
Aucune base privée, aucune configuration, aucun transcript, aucun identifiant : seulement du code public. Un test vert ne
prouve ni un appel de modèle, ni un démarrage réel d'OpenClaw 2026.10.9, ni une recette sur le téléphone.
