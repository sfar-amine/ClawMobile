# F5.3 — Préparer et juger le parcours web manuel

Propriétaires réutilisés : `installer/termux-lite/companion-acceptance.py`, la route GET de run existante, le schéma `runWeb.ts:readRunWebResult`, les constantes Python de budget et le répertoire des reçus de déploiement. Aucun POST métier, appel de fournisseur, exécution de modèle, nouvelle route ou nouveau runner.

## Sources et limites

Claude a [rapporté les métadonnées de deux runs conservés sur le S24](https://github.com/sfar-amine/samantha-ui-playbooks/pull/189#issuecomment-6249000362), en lecture seule le 18/10 vers 11:55 à Tunis. Le run answer du 18/10 a pris 17 secondes ; la recherche seule du 17/10 n'a produit aucune affirmation. Aucun run web échoué ni trace de dictée n'était conservé. La fixture de ce lot reprend uniquement ces observations, sans inventer session/client/timestamps absents ou pages figées.

Un test peut compléter cette projection avec une **enveloppe synthétique explicitement identifiée**, validée par le schéma existant. Ce n'est pas un reçu de recette réelle. Le passage de la recette vérifie identité, dates, terminaison, forme, opération et budget ; il ne certifie pas la véracité des affirmations. Le contrôle de pertinence, des dates et des contradictions appartient au lot web du §10 du document 63.

## Commandes pour Claude et geste d'Amine

Claude relève d'abord la session de discussion de recette et les deux racines actuellement déployées. Il fournit explicitement la racine Git core et la racine playbooks au script ; aucune release n'est devinée.

```bash
python3 installer/termux-lite/companion-acceptance.py \
  --web-recipe prepare --session-id SESSION_DE_RECETTE \
  --web-operation answer --web-core-root RACINE_CORE_DEPLOYEE \
  --playbooks-root RACINE_PLAYBOOKS_DEPLOYEE
```

Le résultat donne `recipeId` et le fichier `web-recipe-<recipeId>.json`. Le checkpoint contient la date `preparedAtMs`, la session, l'opération attendue et les empreintes des contrats. Le retour `prepared` ne signifie pas que le parcours est réussi. `--web-client-run-id` est optionnel si Claude connaît déjà cet identifiant ; il ne crée ni n'impose un identifiant à l'app.

Amine fait ensuite lui-même sa demande web dans la session choisie. Claude lit l'identifiant du run existant et lance :

```bash
python3 installer/termux-lite/companion-acceptance.py \
  --web-recipe judge --web-recipe-id IDENTIFIANT_RETOURNE \
  --web-run-id RUN_EXISTANT --web-core-root RACINE_CORE_DEPLOYEE \
  --playbooks-root RACINE_PLAYBOOKS_DEPLOYEE
```

Le seul appel HTTP est GET `/v1/runs/<runId>`, avec le plafond de lecture déjà fixé pour les runs dans la recette existante. L'outil ne choisit pas « le dernier run », ne déclenche pas la recherche et n'effectue pas de POST de test. Le mode par défaut de l'acceptance, lorsqu'aucun `--web-recipe` n'est demandé, reste intégralement inchangé.

## Jugement et preuves minimales

- Le run lu porte exactement l'identifiant demandé et la session préparée, ainsi qu'un clientRunId opaque ; si ce dernier a été fourni à la préparation, il est identique.
- `submittedAt` et `updatedAt` proviennent du JSON public existant (`submittedAt` projette `acceptedAt` du registre). Ils sont ordonnés après le repère préparé et avant le jugement. Un ancien run ne peut pas qualifier le geste.
- Le run est terminal ; l'opération correspond au choix `search`/`answer`. Une recherche réussie ne passe pas pour une réponse synthétisée.
- Les sources, affirmations, appuis et citations passent par le **validateur existant** compilé `dist/companion/runWeb.js`. Python n'en définit pas un deuxième schéma.
- Les valeurs de budget sont lues par AST, sans exécuter les producteurs : `PUBLIC_WEB_BUDGET_MS` dans core `model-fast-path.py`, `BUDGET_MS` et `SEARCH_BUDGET_MS` dans playbooks `skill_intelligence/public_web.py`. La copie core doit être égale au total propriétaire ; le budget de recherche ne dépasse pas ce total. Aucun littéral supplémentaire de 20/12 secondes dans le nouveau code de production. Une absence, divergence ou modification entre préparation et jugement impose une nouvelle préparation.
- Un succès exige `state=done`, `outcome=complete`, aucun `web.error`, `searchMs` présent dans son budget et durée du run dans le budget total. Le schéma existant exige les sources/claims/citations d'une réponse complète.
- Un échec garde son code `web.error.code` et son étape, ou un code précis d'identité, fenêtre, contrat, timing ou HTTP. Un `reasonClass` public déjà porté par le run est conservé. Aucun message d'erreur libre n'est copié.

Le reçu conserve les identifiants de recette/run/client/session, dates, opération, issue, codes, compteurs de sources/claims/citations et durées. **Aucun prompt, réponse, passage, titre, URL, contenu de pièce ou jeton.** La date préparée est un repère temporel, pas une preuve que le geste a été effectué : le run lu après le geste est indispensable.

Le jugement est terminal et idempotent pour le même run ; une recette déjà jugée ne peut pas être réattribuée à un autre run. Les reçus sont privés, atomiques, bornés à 64 KiB et aux 30 derniers de cette catégorie. Aucun reçu de déploiement, rollback ou paiement n'est supprimé. Le verrou existant `companion-deploy.lock` sérialise seulement les lectures/écritures bornées de la recette, jamais l'attente du geste.

## Validation et limites de livraison

La suite inscrite `test-companion-acceptance-web-recipe.py` couvre 14 cas : métadonnées réelles dans enveloppes synthétiques, search versus answer, causes synthétiques selon le contrat existant, un GET explicite sans POST, confidentialité du reçu, idempotence, identité/fenêtre, budgets, validation canonique des citations, cause existante, dérive de contrat, rétention et refus en cours de déploiement.

Les suites existantes de l'acceptance restent vertes ; la CI complète et sa sortie doivent être rejouées sur le head exact de la PR. Aucun reçu S24 n'est produit par Codex. Claude déploie et fait la recette avec Amine. La dictée doit d'abord être instrumentée dans son propriétaire app ; la voix en direct reste à Claude. Paiement et décision D inchangés.
