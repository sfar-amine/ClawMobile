# Recette de formulations du 03/11 — outils typés et pièce Pulse

Trois écarts relevés par la recette de formulations du 03/11 sur le S24, corrigés côté plugin. Le modèle choisit toujours l'action et ses paramètres ; le code ne fait que tolérer ce qu'il peut tolérer sans risque, à partir de la déclaration existante des actions (Capability Graph). Aucune nouvelle table et aucune nouvelle règle de décision.

## 1. Paramètres d'une autre action (cra.status, finance.ca)

Constat : le schéma partagé d'un outil typé présente au modèle les paramètres de toutes ses actions. Le cerveau a passé à `cra.status` et `finance.ca` (aucun paramètre déclaré) des paramètres d'une autre action. Le propriétaire a refusé l'appel entier (`owner_input.validate_value` : `parameter_fields`), le cerveau a répondu « l'erreur vient de moi » puis a refait un essai (+15 s).

Correctif (`typedCapabilityTools.ts`, `fitActionParams`, utilisé par l'outil du propriétaire et par celui des pièces) :
- **Lecture** : les paramètres de premier niveau que l'action ne déclare pas (`action.params.properties`) sont retirés avant l'appel à l'hôte. Le résultat porte `ignoredParams` et une consigne : ne pas les présenter comme appliqués.
- **Écriture** : elle n'est jamais lancée avec un paramètre retiré. Rien n'est exécuté et le cerveau reçoit les paramètres de l'action (`typed_params_not_accepted` pour le propriétaire, `NEEDS_INPUT` / `parameter_not_accepted` dans une pièce).
- `confirm`, `cancel`, l'arrêt de génération et `active_generations` restent inchangés.

## 3. Valeur requise manquante dans une pièce (offer.team sans offre)

Constat : dans la pièce Pulse, `offer.team` appelé sans `offer_id` finissait par « Je n'ai pas de résultat vérifié de Pulse… ».

Correctif (`roomBrain.ts`) : un paramètre requis de l'action absent, nul ou vide est détecté avant toute lecture du droit. L'outil renvoie au cerveau du contact `NEEDS_INPUT` / `parameter_missing`, avec le nom du paramètre et sa description quand le catalogue en a une. La consigne : si les mots du contact permettent de retrouver la valeur avec une autre action du même outil (une recherche), le faire ; sinon poser au contact une seule question courte, sans proposer ni inventer de valeur. Rien n'est lu ni exécuté.

La question d'un propriétaire (`project.create` : « Quel est le nom exact du projet ? ») reste remise telle quelle. Le catalogue ne porte pas de phrase par paramètre, et ce mécanisme ne vit que dans les préparations d'écriture des playbooks. Ici, c'est donc le cerveau qui formule la question.

## 4. Ce que la pièce Pulse annonce

Constat : la phrase de refus, la portée d'une pièce combinée et la consigne de l'outil disaient « projets, offres, congés de l'équipe et solde de congés ». Pourtant la pièce sert aussi `finance.ca`, les évaluations et les CRA : Amine a décidé que les lectures privées Pulse restent ouvertes dans la pièce.

Correctif : les sujets nommés sont dérivés de `roomActions()`. Chaque famille d'actions a un libellé (projets, offres, chiffre d'affaires, évaluations, CRA, congés de l'équipe, solde de congés), nommé seulement si la pièce expose l'une de ses actions. Le texte complet devient « Ici je ne traite que Pulse : projets, offres, chiffre d'affaires, évaluations, CRA, congés de l'équipe et solde de congés. Pour le reste, vois directement avec Amine. »

Le préfixe lu par `deploy-parcours.py` est inchangé. Aucun droit n'est retiré. La consigne d'agent de la pièce (`pulse-room.py`, AGENTS.md) nomme les mêmes sujets.

## 2. samantha_qa et DIRECT_TYPED_TOOLS

Non modifié. L'absence est voulue : note `brain-qa-typed-tool-20261102` et `test-typed-qa-tool.cjs` (« outil rare, trouvé par la recherche d'outils, sans coût sur la surface directe du prompt »). La recette montre le coût de ce choix : lecture du SKILL puis `tool_search`. Passer l'outil en direct est une ligne, mais cela consomme une surface de prompt déjà proche de son budget (32 725 / 34 000 caractères). C'est à Amine de décider.

## Tests (inscrits dans `.github/workflows/ci.yml`)
- `openclaw-plugin-mobile-ui/scripts/test-recette-formulations.cjs` : les trois écarts, côté propriétaire et côté pièce. Apparié aux playbooks (`ROOM_PLAYBOOKS_ROOT`), il vérifie que le validateur du propriétaire refuse les paramètres mélangés et accepte les paramètres ajustés. Il échoue sur l'ancien code.
- `test-pulse-room-brain.cjs` et `test-contact-room-brain.cjs` : l'attente du refus Pulse est dérivée de la capture S24 du 02/11. Cette capture ne contient pas `finance.ca`, donc la phrase ne dit pas « chiffre d'affaires ».

Fixtures :
- `fixtures/s24-2026-11-02-pulse-room-brain/` : capture S24 du 02/11, 14 des 37 actions, les 37 noms et risques, droit du contact de recette ;
- `fixtures/s24-2026-10-25-typed-tools/` : projection compilée du domaine Pulse complet (`finance.ca`, `evaluations.team`, `offer.team`).

Aucune nouvelle capture.

## Retour arrière
Revert de ce commit puis `companion-deploy.sh <commit>`. La consigne de la pièce Pulse suit le même commit. Rien à restaurer sur le S24.
