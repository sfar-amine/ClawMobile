# Model-flow OpenClaw 2026.10.9 : tests de comportement — 1er novembre 2026

Étape 2 de la montée OpenClaw 2026.9.6 → 2026.10.9 (empilée sur l'étape 1, table de versions du SDK).

Les trois tests de comportement des flux de modèle prennent la version épinglée en argument :
- sans argument (ou `2026.9.6`) : la capture S24 du 25/10, inchangée ;
- `2026.10.9` : les mêmes invariants sur les fonctions publiques du paquet npm candidat.

Fichiers des tests : `test-model-flow-setup.cjs`, `test-model-flow-compaction.cjs`, `test-model-flow-native-session.cjs`. Un module commun, `model-flow-sdk-fixtures.cjs`, choisit les sources de chaque version et vérifie leurs SHA256. Il lit aussi le module du contrat de profil dans `openclawSdkVersions.ts`, la table de l'étape 1.

## Invariants vérifiés en 2026.10.9

- **Sélection de modèle par hook** :
  - réglages fermés et validés ;
  - hook du seul plugin propriétaire, attendu avant la planification des candidats ;
  - priorité du verrou, 20 replis, effacement explicite ;
  - configuration globale jamais modifiée ;
  - réglages appliqués avant l'authentification native.
- **Compaction** :
  - résumé attendu avant la préparation, épinglé sur le modèle seul, à travers les configurations relues ;
  - héritage du `null` ;
  - sessions verrouillées et préflight transcript intacts ;
  - refus avant préparation ;
  - compte de résumé explicite consommé par la cible native.
- **Persistance du profil et CAS** : le `pin` réel de `conversationModelProfile.ts` passe par le `patchSessionEntry` public 2026.10.9, avec le writer worker (cas de production) et le writer direct.
  - Le premier pin gagne.
  - Une remise à zéro entre lecture et pin est refusée (409).
  - Une écriture concurrente d'un autre processus entre préparation et commit est refusée par le CAS du writer, sans écriture périmée ; une nouvelle tentative garde les deux.
  - Sur 451 lignes, le budget de 25 s tient.
- **Épinglage des types** : les trois déclarations de `config-contracts-DzLaG7FV.d.ts` sont identiques aux épinglages 2026.9.6.

## Écarts trouvés (aucun invariant cassé)

- Le contrat de profil et ses fonctions vivent maintenant dans `embedded-agent-DoEPu8ye.mjs`, ce que dit déjà la table.
- Le hook est entouré par l'admission de réclamation de l'appelant et par l'autorité de requête protégée. Un appelant révoqué ne l'atteint pas, et une révocation pendant l'attente écarte ses réglages. Ce comportement est nouveau et désormais testé.
- La compaction lit l'entrée par le lecteur worker asynchrone. Une annulation avant la lecture ou pendant le hook arrête le résumé.
- `patchSessionEntry` donne au plugin une entrée projetée : les clés privées sont masquées, puis rétablies pour la même génération. `pluginExtensions` est conservé. Sans garde de commit fourni par le plugin, l'écriture passe par le noyau worker.

## Fixtures

`openclaw-plugin-mobile-ui/fixtures/openclaw-2026.10.9-model-flow-sdk/` contient des extraits de fonctions de 14 modules, avec le SHA256 de chaque module et de chaque extrait. Deux petits modules sont entiers. La provenance est dans le README : `npm pack openclaw@2026.10.9`, archive `43c61a00…`, extraction ciblée, archive supprimée. Les modules corrigés sont lus dans `openclaw-2026.10.9-compat`.

## CI

Une étape 2026.10.9 est ajoutée à côté de chaque étape existante :
- setup et compaction dans le job principal ;
- session native dans le job Node 26.

Les étapes 2026.9.6 sont inchangées.

## Limites

Restent des ports rédigés :
- le transport worker : thread, trames, reçu de commit ;
- l'écriture et la fusion d'entrée ;
- les gardes d'identité de base.

Aucun code 2026.10.9 n'est importé : ses moteurs demandent Node 24.22.1+ ou 26.12.1+. Le démarrage isolé sur le S24 relève de l'étape 3.

## Retour arrière

Revert du commit. Ni le runtime ni le S24 ne changent.
