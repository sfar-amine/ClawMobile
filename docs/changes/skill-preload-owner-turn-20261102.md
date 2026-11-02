# #126 : skill préchargé par tour pour les domaines typés fréquents — 2026-11-02

## Constat (S24 02/11, OpenClaw 2026.10.9)
Premier tour « Qu'est-ce que j'ai dans mon agenda demain ? » : environ 17 s une fois la session ouverte. Le prompt de
l'hôte demande de lire le skill avant d'agir, mais `skills_read` est catalogué derrière Tool Search. Le tour enchaîne
donc modèle → `tool_search` (3,4 s) → modèle → `skills_read` (4,6 s) → modèle → `samantha_agenda` (déjà direct) → réponse.
Environ 8 s servent à découvrir le skill.

## Changement
1. **Préchargement par tour** (`src/ownerSkillPreload.ts`, appelé par le hook owner `before_prompt_build` existant).
   - Si la demande du propriétaire relève clairement d'un seul domaine, le `SKILL.md` installé
     (`~/.openclaw/workspace/skills/<nom>/SKILL.md`) est ajouté au tour dans `prependContext`.
   - Domaines : agenda → `samantha-agenda` ; factures → `samantha-factures` ; Orange/télécom → `orange-telecom` ;
     téléphone → `samantha-appareil`.
   - Le bloc est marqué « Instructions du skill <nom> déjà chargées pour ce tour : ne pas les relire ».
   - `prependSystemContext`/`appendSystemContext` ne changent pas : le préfixe système reste en cache.
   - La correspondance utilise une table fermée de mots (FR, derja en lettres latines, EN). Un mot fort suffit ; un mot
     faible (« solde », « orange », « sms ») en demande un second du même domaine. Si un autre domaine marque aussi,
     rien n'est ajouté.
   - Rien n'est ajouté non plus pour les mots d'ingénierie ou Pulse (skill, playbook, commit, déploiement, recette,
     capability) ni pour un texte de plus de 1 200 caractères. La découverte normale reste alors.
   - Coût : aucun appel modèle ni processus ; un `stat` par tour apparié et une relecture seulement si le fichier a
     changé. Un fichier de plus de 16 Kio ou au mauvais frontmatter n'est jamais injecté. Toute erreur donne : rien.
   - Portée : agent `main` dans l'espace de travail propriétaire (WhatsApp propriétaire, Companion, voix). Jamais pour
     les contacts, les pièces Pulse/Projet, le cron, le heartbeat, les sous-agents ni les entrées inter-session ou système.
   - Le préchargement est indépendant du drapeau `SAMANTHA_CONTEXT_FOUNDATION`. Il se coupe avec `SAMANTHA_SKILL_PRELOAD=0`.
2. **Filet pour les autres tours** (`installer/termux-lite/model-efficiency-config.py`, propriétaire existant de
   `agents.entries.*`) : `skills_read` et `skills_search` sont ajoutés à `agents.entries.main.tools.deny`.
   - L'ajout fusionne avec la politique existante : aucune entrée retirée, ordre gardé, politique non conforme laissée telle quelle.
   - L'hôte revient alors à « Clear match: read exact <location> with `read` » : un seul appel direct au lieu de deux
     (vérifié en direct le 02/11).
   - Pourquoi pas une voie plugin :
     - `catalogMode` appartient à l'outil du cœur, pas au plugin.
     - `toolsAllow` par tour ne fait que restreindre par liste d'autorisation. OpenClaw réautorise `skills_read` dès que
       `read` est autorisé (`openclaw-state-read.worker`, fixture 2026.10.9). Ce champ désactive aussi le pré-filtre
       d'outils de l'hôte (garde `hook-tool-policy`).

## Fixtures
`openclaw-plugin-mobile-ui/fixtures/playbooks-2026-11-02-skill-bodies/` : corps source des quatre skills (playbooks
`de922be4`), que l'activation recopie à l'identique sur le S24. Les empreintes S24 du 25/10 correspondent aux
versions source de l'époque. C'est une projection, pas une capture : les empreintes installées restent à relever.

## Reste à mesurer en production
- Gain du premier tour apparié (attendu : environ 8 s) et absence de relecture du skill par le modèle malgré le marqueur.
- Tour non apparié : un seul `read` du `SKILL.md`, sans `tool_search` ni `skills_read`.
- Après le déploiement : `model-efficiency-config.py --apply`, puis un redémarrage propre de la Gateway.

## Retour arrière
- Rapide, sans déploiement :
  - mettre `SAMANTHA_SKILL_PRELOAD=0` dans l'environnement propriétaire, puis redémarrer proprement la Gateway ;
  - retirer `skills_read` et `skills_search` de `agents.entries.main.tools.deny`.
- Complet :
  - revert du commit ;
  - `companion-deploy` vers le commit précédent ;
  - même retrait des deux entrées, que le script reverti ne fait pas.
