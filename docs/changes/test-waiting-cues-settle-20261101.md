# Test des annonces d'attente : plus d'attente fixe de 20 ms (01/11/2026)

Maintenance de test uniquement. Aucun code produit n'est modifié.

## Problème
`openclaw-plugin-mobile-ui/scripts/test-voice-waiting-cues.cjs` a échoué une fois en CI locale chargée, à la première assertion sur l'activité (vers la ligne 73), alors qu'il passait 15 fois sur 15 au repos. Le test envoyait une trame à l'observateur Gateway, attendait 20 ms (`settle`), puis lisait le statut du run. Or l'observateur enregistre chaque trame dans sa propre file d'écriture bornée, puis dans le registre des runs (`mutateRegistry`, écriture du fichier). Sur une machine chargée, cette écriture ne tient pas dans 20 ms : le statut lu n'a pas encore l'activité. C'est une course du test, pas un défaut du code.

## Correctif
- `settle` est supprimé. Une aide `until(lecture, condition, quoi)` relit le statut toutes les 5 ms jusqu'à ce que l'effet attendu soit enregistré, avec un plafond de 5 s. Au-delà, le test échoue en disant quel effet manque et avec le dernier statut lu.
- **Première activité** : on attend qu'elle soit visible à la fois par id et par clientRunId, puis on vérifie qu'il s'agit bien de `samantha_utility_billing` / `bill.status`.
- **Trames sans effet** (résultat d'outil, découverte `samantha_catalogue`) : attendre « que rien ne change » ne prouve rien. On ajoute donc une barrière ordonnée : une étape titrée d'un outil non typé (`read`, « Je prépare ta demande »). La file de l'observateur est FIFO, donc quand cette étape est visible, les deux trames précédentes ont été appliquées. On vérifie alors que l'activité n'a pas bougé. La barrière confirme aussi qu'un outil non typé, même titré, n'est jamais une activité.
- **Appel typé suivant** : on attend que l'activité quitte `bill.status`, puis on vérifie qu'elle vaut exactement `samantha_agenda` / `agenda.event.create`.
- **Appel typé titré** : on attend l'étape publique « Je consulte ton agenda ».

Aucun test n'est désactivé ni sauté, et aucune assertion n'est retirée. Les numéros de séquence des trames suivantes sont décalés d'un cran pour faire place à la barrière.

## Vérification
Sur un conteneur à 4 vCPU, après `npm ci && npm run build` :
- 30/30 au repos ;
- 30/30 avec deux boucles `yes` actives ;
- 30/30 en lançant 3 exécutions concurrentes sous six boucles `yes`. Dans ces mêmes conditions, la version de base échoue 9 fois sur 30.

`test-voice-deferred-readback.cjs` (16 cas) et `test-voice-brain-delegation.cjs` (28 cas) passent, sans changement. Le test est déjà inscrit dans `.github/workflows/ci.yml` (job `mobile-ui-plugin`).

## Routes, capacités, fixtures
- **Routes** : aucune.
- **Capacités** : aucune, impact nul.
- **Fixtures** : captures S24 existantes, inchangées.
- **Déploiement** : sans objet.

## Retour arrière
Revert de ce commit. Il ne touche qu'un script de test, donc rien à redéployer.
