# F5.3 — Recette web explicite avant/après le geste d'Amine

`companion-acceptance.py` reçoit un mode **optionnel** `--web-recipe prepare|judge`. La recette automatique par défaut et ses lectures/gardes, y compris les refus du paiement, restent identiques. Ce mode ne soumet aucune demande : il prépare un repère daté, puis lit un seul run explicitement choisi après le geste d'Amine.

Le [contrat de recette](../work/samantha-runtime/contracts/f5-web-gesture-recipe-20261018.md) précise les commandes, les sources de budget, le propriétaire du schéma et les limites. Les reçus restent sous `~/.openclaw/deploys`, bornés à 64 KiB chacun et aux 30 derniers de cette catégorie. Le verrou de déploiement existant est tenu uniquement pendant la préparation ou le jugement, pas entre les deux. Aucun nouveau store, runner, service ou route.

Validation ciblée : **14/14** nouvelles recettes de test, inscrites dans `.github/workflows/ci.yml`, plus **16/16** tests existants de recette (settle 7, owner transport 3, voix 6) et **3/3** d'inscription CI. Compilation Python/TypeScript et diff-check verts. Une comparaison AST avec la base `6592da8e` confirme que `main`, `READS`, `OWNER_GUARDS` et `OWNER_GUARD_BUDGETS` sont inchangés. La CI locale complète sur le head exact de cette PR reste nécessaire.

Les métadonnées réelles de réponse web rapportées par Claude le 18/10 sont conservées dans `fixtures/foundations/s24-web-gesture-observations-20261018.json`. La capture est explicitement une projection incomplète, pas un GET complet. Les champs manquants des enveloppes et les échecs sont **synthétiques dans les tests**, avec le schéma du propriétaire, conformément à la réponse de Claude ; aucun échec réel retenu n'existait alors. Le test de succès n'est ni une recette S24 ni une preuve de vérité de l'affirmation sur le reset Codex.

Pas de changement de paiement, de voix en direct ou d'environnement D. La dictée reste sans trace runtime disponible et n'est pas qualifiée par ce lot. Aucun appel ou effet S24, aucun déploiement. Retour arrière : retirer le mode optionnel et ses reçus de recette seulement, sans migration ni modification des runs.
