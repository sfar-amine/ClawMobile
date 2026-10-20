# F3 — Diagnostic vocal dans le checkpoint existant

Le propriétaire reste `runs.ts:saveVoiceTurn`, sur le POST de checkpoint vocal existant. Cette tranche runtime accepte une projection facultative des événements de l'app ; elle ne capture rien sur le téléphone. La contrepartie app doit la déposer sur un **tour déjà existant**. Un échec de préparation sans tour ni transcription reste dans la trace de session existante : aucun faux tour vide n'est créé.

## Contrat fermé

Le checkpoint ajoute seulement `diagnostics`, recopié dans `voiceDiagnostics` du reçu et de sa projection de statut. Il contient `version: 1`, `startedAtMs`, `truncated` et `events`.

- `startedAtMs` : entier de millisecondes d'époque, de zéro au 1er janvier 2100.
- Au plus 32 événements, chacun avec `code` C1 app et `elapsedMs` entier de zéro à une heure. Les durées ne décroissent pas ; leur somme avec le repère reste dans la borne de date.
- `failureFamily` est facultatif, seulement sur `t90`, et reprend exactement les six familles du rendu F2 : `token`, `before_setup`, `setup_timeout`, `protocol`, `sequence`, `correlation`. Une panne non classée porte `t90` sans famille, jamais sa cause réseau libre.
- Aucun autre champ n'est accepté, ni texte, audio, transcription, secret, URL ou identifiant supplémentaire.

La fixture `fixtures/protocol/voice-turn-diagnostics-v1.json` représente ce contrat, avec un exemple projeté depuis les horodatages du log S24 du 18/10 déjà rejoué par `test-claw-trace.py`. L'enveloppe est nouvelle et explicitement contractuelle ; ce n'est pas un reçu réel. La liste C1 reprend les événements effectivement émis par l'app. Les listes du validateur et de la lecture Python sont comparées à cette fixture par les tests. La copie JVM sera vérifiée contre ce propriétaire runtime et son SHA explicite, séparément du contrat F1 app/Companion.

## Persistance et rétrocompatibilité

Les checkpoints sans le champ restent acceptés. Un checkpoint ultérieur qui omet la métadonnée conserve le résumé déjà enregistré. La validation précède toute écriture. Le résumé est détaché de l'objet appelant, relu par le propriétaire du registre et exposé dans le statut vocal ; une métadonnée corrompue dans un ancien fichier est absente de la projection.

Les règles de révision, de session, de suppression et de terminalité restent celles de `saveVoiceTurn`. Une révision déjà traitée restitue son ancien reçu. Une métadonnée ne permet aucune réouverture d'un tour final ; l'amendement de lecture interrompue existant conserve ses conditions. Aucun effet, outil ni intention n'est exécuté par le diagnostic.

## Lecture corrélée

`claw-trace --turn <id>` lit les résumés fermés dans le registre de runs existant. Il émet `turnId`, `runId`, code C1, durée et famille facultative, sans copier `input`, `output`, `userText`, `result` ou erreur libre. Les événements sont datés avec le repère app plus la durée, donc restent des métadonnées déclarées par l'app, pas une preuve indépendante de l'effet.

Quand un résumé valide correspond au tour et à la fenêtre demandés, cette lecture ne lance **aucune commande ADB**. Le comportement historique reste disponible pour les anciens tours dépourvus de résumé et les lectures de fenêtre ; `--no-app` l'interdit explicitement. Un résumé mal formé est rejeté en entier par le lecteur, jamais rendu partiellement.

## Budgets et livraison

Aucune route, capability, lecture Gateway, file ou magasin supplémentaire. Le POST existant garde son budget ; le validateur travaille sur au plus 32 événements et le résumé maximal fait moins de 4 Kio. La rétention et les bornes du registre existant s'appliquent. Aucun parcours de paiement n'est touché.

Les neuf cas Python passent hors téléphone, dont la corrélation sans ADB et le rejet des formes sensibles. Le nouveau test CJS inscrit dans la CI rejoue le vrai `saveVoiceTurn` puis la relecture du reçu, les révisions, la terminalité, les bornes et les négatifs ; sa compilation et son exécution sont encore en attente du créneau CI. La CI locale canonique sur le head exact et le numéro de PR reste requise avant fusion. Claude assure revue, déploiement, contrepartie app et recette physique.

Retour arrière : revert de cette tranche ; les tours historiques restent lisibles et les checkpoints sans diagnostic gardent leur contrat.
