# L1 — plan de recette et mesure de référence

État : préparation de source seulement. L0 n’est pas déclaré clos ; aucune demande en direct, mesure de référence ou réussite métier n’est produite par ce lot préparatoire.

## Scénarios et contrat

Le fichier `openclaw-plugin-mobile-ui/fixtures/refonte-parcours-unique/L1-scenarios.json` contient exactement les douze scénarios minimum de la spécification, soit 32 couples scénario/surface (les deux gestes exclusivement vocaux ont une seule surface). C’est un plan rédigé, explicitement `runtimeCapture:false`, jamais une capture de résultats S24. Les capabilities viennent de `registry.json`, leurs domaines de `execution_graph.json`, les intentions et paramètres des manifestes du SHA déclaré. La validation statique refuse une autre révision : il faut réviser cette provenance et les attentes si le pin de recette change. Aucun numéro ni identifiant privé de contact n’est versionné.

Toutes les entrées ont `stopAtConfirmation:true` et `allowWrite:false`. La cible WhatsApp est liée au propriétaire seulement, résolu par son propriétaire d’identité existant ; ce plan n’envoie rien. La date future de l’événement doit encore être future lors de la recette, sinon le scénario est replanifié avant admission. Les deux écritures réelles autorisées par Q3 nécessitent un scénario distinct explicite et leur preuve d’autorisation ; elles ne sont pas activées en modifiant silencieusement ces gardes. Paiements et tiers exclus.

## Propriétaire existant

`companion-acceptance.py` possède déjà des modes explicites de préparation/jugement Web. Il reçoit ici seulement un mode `--journey-scenarios-validate PLAN --playbooks-root SOURCE` qui valide le plan localement, sans appel réseau ni runtime, puis retourne `runtimeExecuted:false`. Il utilise le validateur JSON Schema déjà épinglé dans les dépendances QA ; l’absence de ce module refuse la validation, sans installer quoi que ce soit. Le mode de déploiement sans argument garde toutes ses lectures et ses refus sans ownerheader.

La recette nocturne est également limitée aux lectures/refus : elle ne doit pas être transformée implicitement en lanceur de demandes. L’extension suivante doit rester un mode explicite de `companion-acceptance.py`, séparé de sa recette automatique. Elle pourra préparer les identifiants et juger des preuves déjà produites par les vrais propriétaires des surfaces ; aucun nouveau runner, routeur, store, scheduler ou retry. L’ajout d’une admission live attend les contrats et captures courants vérifiés sur le S24 par le responsable du chantier.

## Ce qu’une preuve doit attester

- App : admission par le geste natif, ID de run, trace de l’agent, reçu et timestamps de la même demande.
- WhatsApp : message entrant depuis le fil propriétaire, indicateur de frappe, trace et reçu, réponse dans ce même fil. Un appel direct au Graph n’est pas une recette WhatsApp.
- Voix : stimulus, microphone réellement admis, transcription et identité du tour, trace, mesure et reçu du même tour. Une injection QA de texte, une simulation de protocole ou une lecture TTS dans le haut-parleur ne valent pas la preuve du microphone.
- Interruption : reprise de parole effectivement observée pendant l’attente ; arrêt de la phrase d’attente, des relances et de l’avancement vocal.
- Différé : délai supérieur au budget réellement observé et livraison dans la même surface et le même fil ; une réponse rapide ne valide pas ce scénario. Une simulation contrôlée garde sa provenance distincte et ne vaut pas latence native réelle.

Un effet incertain se juge sur son reçu original et son statut, jamais par une nouvelle soumission. Chaque intention conserve son action_key et les identifiants de session/run attendus. Les notes de mémoire restent des résumés sans transcript.

## Mesure de référence et portes

La baseline est une observation de l’état antérieur à L2, réalisée après L0 vert. Elle enregistre le temps au premier signe de vie, décision, outil, réponse utile et total ; un champ non observable reste null/non mesuré, jamais zéro. Sources à confirmer avant lecture : runs du Companion, `trajectory_runtime_events` et `[voice-turn]` déjà existants. Aucun nouveau store ni ligne de texte utilisateur dans les mesures.

Trois états restent distincts : (1) plan statiquement valide ; (2) collecte de référence complète et correctement sourcée ; (3) comportement conforme. Une baseline correctement mesurée peut documenter un échec réel ; cet échec n’est ni un PASS fonctionnel ni un blocage de la collecte elle-même. Les défauts constatés sont enregistrés avec leur propriétaire et leur scénario.

Le critère propre à la baseline L1 est son enregistrement avant L2, sans fabriquer une réussite de l’ancien aiguillage que L3 doit corriger. La recette du changement L1 doit, elle, être verte : le geste d’app enregistre le marqueur via le propriétaire existant, son rejeu ne double pas l’effet et la carte Compréhension compte ce retour. Les objectifs globaux 100 % des scénarios / homogénéité / aucune double décision restent à démontrer après la bascule L3 et lors de la recette finale ; ils ne sont pas rétroactivement attribués à la baseline. Si une porte exige la réussite fonctionnelle de tous les scénarios dès L1, elle reste rouge tant que les défauts persistent : jamais de clôture verte en changeant le sens de PASS.

Retour arrière : retirer ce mode explicite et les fichiers de plan ; les propriétaires et données runtime sont inchangés. Parité MCP : sans impact, aucune primitive ni schéma MCP modifié. NO_CAPABILITY : mode de validation statique d’un plan de recette, aucune route métier ou owner HTTP ajoutée.
