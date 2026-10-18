# F3 — Corrélation dans les journaux et la commande de trace

Le journal borné accepte désormais des identifiants fournis explicitement par son appelant, et `claw-trace.py` filtre une fenêtre sur un identifiant exact. Aucun nouveau journal, index persistant ou service n'est créé.

- `bounded-log.py <journal> --stream --timestamp --correlation runId=run_…` préfixe chaque ligne une seule fois ; `turnId` et `clientRunId` sont également admis. Plusieurs clés peuvent être fournies. Sans option de corrélation, le format demeure inchangé. Le mode `--append` accepte les mêmes clés.
- Les clés sont fermées, les valeurs bornées à 128 caractères opaques, et les doublons ou valeurs invalides sont refusés sans les recopier dans l'erreur. Cela ne remplace pas la responsabilité de l'appelant de ne fournir que des identifiants techniques.
- `claw-trace.py --run run_…`, `--turn turn_…`, `--client-run client_…` ou un argument positionnel filtrent les champs nommés exacts, dans la fenêtre temporelle existante, archives comprises. Plusieurs filtres se combinent par intersection. Aucun appariement par sous-chaîne ni rapprochement supposé entre deux identifiants distincts.
- Le lecteur du registre des runs utilise les identifiants déjà persistés par le propriétaire. Il ne copie plus le champ d'erreur libre ; seul `reasonClass`, lorsqu'il respecte le format de code public, est projeté. Ni texte de demande ni résultat ni contenu de pièce ne sont lus pour le rendu.

## Validation

Les suites existantes et déjà inscrites à la CI couvrent maintenant la corrélation : `test-owner-retention.py` (11/11) et `test-claw-trace.py` (5/5), soit 16/16 ciblées. Le test des runs rejoue les formes de la capture S24 `fixtures/s24-2026-10-11c/hs5-runs-shapes.json`, capturée par Claude le 11/10 ; les horodatages absolus absents de cette capture nettoyée sont remplacés par une horloge de test explicitement synthétique.

Pas de nouvelle route ni capability : il s'agit des outils de journalisation/diagnostic existants, pas d'une entrée métier. Les lectures Gateway et les budgets d'exécution des routes sont inchangés. Les sorties d'`adb`, le checkpoint vocal et les producteurs de voix en direct restent à Claude ; ce point ne prétend donc pas rendre à lui seul toute la chaîne vocale lisible sans `adb`.

La journalisation structurée des producteurs Companion est un autre point de F3, à porter dans le module de journal canonique confirmé avec Claude. Le présent changement ne crée pas un second logger pour le remplacer.

## Livraison et retour arrière

CI locale intégrale sur le head exact et numéro de PR à fournir avant qualification. Aucun déploiement ni recette S24 effectués par Codex. Le retour arrière consiste à revenir au code précédent dans la ligne de livraison ; les journaux existants gardent leur format et leur rétention.
