# Q13 — accès WhatsApp aux tests Android, par application

Lot préparé hors téléphone, non déployé. La commande privée `people-trusted.py qa-scope-read`
relit l'autorité du contact avant chaque usage asynchrone. Les grants restent
dans l'en-tête privé existant du contact ; aucune nouvelle base d'autorisation.
Une session ou un DTO ne constitue jamais, seul, une autorisation.

Le propriétaire des pièces conserve `qaApps` (12 au plus), dans la pièce `qa`.
Chaque app porte un nom public, un paquet interne, un environnement et le droit
d'écriture, faux par défaut. L'ajout d'une app ou le changement de son périmètre
exige la confirmation biométrique existante, même si la pièce est déjà ouverte.
Le hash de confirmation est identique en Python et TypeScript. La révision de
l'autorité est vérifiée entre la préparation et l'effet. Retrait, suspension,
expiration et binding concret manquant refusent la lecture privée.

L'entrée QA transporte le texte du contact sur stdin privé, jamais dans argv,
l'événement de dialogue ni la politique. Le propriétaire QA traite les données
du compte avant le Graph ; une version de playbooks sans cette frontière est
refusée. Seul un texte structuré généré par QA atteint ensuite le Graph, avec
un second pipe privé indépendant du stdin de sa décision. Les autres capabilities
conservent leur admission. Aucun changement au paiement, à la voix directe ou
à l'environnement D. Budget de l'entrée : 15 s, dont lecture locale d'autorité
3 s au plus et une enveloppe monotone partagée de 11 s pour les helpers,
y compris les candidats absents ; aucune boucle de réessai d'effet. Un test
de vrais sous-processus (autorité lente de 2 s puis helper bloqué) vérifie
la réponse en moins de 15 s et l'absence de deuxième invocation.

Sources : signatures des cinq propriétaires installés relevées en lecture seule
par Claw sur le S24, checkout `145339bbae88ffd66fb7475fcbf275b379d9cb6a`, fixture
`openclaw-plugin-mobile-ui/fixtures/qa/q13-existing-owner-source-20261018.json`.
L'ancien GET allowlist nettoyé du S24 du 10/10 est aussi testé : il ne crée aucun
grant QA. Les nouvelles autorisations sont des fixtures synthétiques explicites.

Les tests de lecture courante, absence/révocation/expiry, autre app/contact,
fausse autorité, biométrie dans une pièce existante, révision périmée, parité
du hash et séparation des deux pipes sont inscrits dans la CI existante.

La commande privée `qa-deliver --request-stdin` ne reçoit que la référence de
campagne, le demandeur pseudonymisé, l'app et la phase. Le propriétaire QA
compose le texte ; People retrouve le numéro dans son autorité courante et
relit les droits après cette préparation. Le registre d'envoi existant conserve
les reçus : un état incertain n'est jamais rejoué. Les nouvelles réservations
QA sont refusées atomiquement à 50 000 reçus, sans effacer les incertains.
Les campagnes peuvent conserver des droits plus étroits que le grant courant.
Les documents passent par le propriétaire média SDK installé : octets privés sur stdin, staging dans son stockage existant, puis `mediaUrl` dans le schéma Gateway confirmé. Le reçu accepté est persisté avant nettoyage ; un envoi incertain conserve sa référence privée et ne se rejoue pas. Le propriétaire réauthentifie après staging et avant envoi. Le contenu est vérifié contre le manifeste expurgé du propriétaire QA, sans modifier son original privé. Budget global18s ; wrapper20s. Le staging reste borné à500 entrées/200Mio, sans nouveau stockage ni collecteur.

Le cycle de santé existant appelle `qa-queue-tick`, sortie fermée et budget de
14 s ; un propriétaire absent reste `NOT_READY`. Une exception après entrée du
propriétaire est `VERIFY_REQUIRED`, jamais une preuve d'absence d'effet. Le
chargement de playbooks passe par `claw-capability.py:ui_root()` et conserve
le verrou partagé de déploiement Q12. Le relevé réel de ce résolveur est dans
`q13-playbooks-root-owner-20261018.json`. Aucun nouveau verrou, store ou timer.

Le formulaire Accès WhatsApp transmet `expectedQaRevision` : une vue ancienne ou une ancienne version de l'app ne peut pas effacer des grants QA invisibles. Les deux propriétaires refusent la divergence avant confirmation ou réservation. Le retrait explicitement préparé sur une vue courante reste possible. Le raccord final est livré avec la PR Q13 playbooks et la correction app R17 ; aucun envoi réel ou accès S24 n'est qualifié par ces fixtures.
La recette physique reste réservée à Claude après revue, fusion et épinglage.
Retour arrière : revenir au commit précédent du lot dans les deux propriétaires ;
les anciens lecteurs refusent les métadonnées QA inconnues, sans élargir l'accès.

Le rapport peut imposer un budget inférieur au wrapper : SIGTERM est relayé au groupe People, dont le handler privé déroule le nettoyage du groupe SDK. La réserve de fermeture reste dans le budget appelant. Les tests réels (38/38 People et11/11 contrats shell) vérifient aussi les descendants ; une interruption après admission reste UNKNOWN et ne déclenche aucun rejeu. Une requête Gateway déjà acceptée ne constitue jamais une absence d’effet prouvée.

Le handler privé couvre également `qa-queue-tick` : le SIGTERM du timeout du cycle de santé déroule le nettoyage des enfants privés avant la fin du processus. Les entrées historiques et le paiement conservent leur comportement. Le cas négatif sans ce handler confirme la régression ; aucun processus envoi n’est laissé en attente d’une relance.

## Propagation de Q12 FINAL après relecture

Merge normal du head Q12 exact `dd80d6928330b008512d1195111d8cbf19951409` dans cette branche Q13, sans réécriture. Le protocole de file/autorité Q13, ses tests et toutes les commandes héritées des deux parents sont conservés, y compris les deux tests de rétention et trace de la clôture voix. Les protections Q12 de réparation/redémarrage, le bail partagé/exclusif et la racine current proviennent exclusivement de leur propriétaire existant ; aucun nouveau verrou ni store n’est ajouté ici.

Ciblés de propagation : construction TypeScript verte ;15/15 tests Python de protection redémarrage (1,202s),9/9 tests du bail de réparation avec vrais flock/current/promotion, et test propriétaire du redémarrage Gateway sous EX vert. Les cinq tests CLI privé→renderer Core sont rejoués avec le producteur Playbooks exact `d420259483ef4f8eaabaff77a972f6334f9c7769` :5/5 verts en2,948s, modes carte et texte. Ce sont des fixtures hors téléphone ; aucun démarrage, envoi ou geste S24 n’est revendiqué.

Ce nouveau head attend la CI canonique complète PR350 dans le créneau root. L’ancienne preuve142/142 au head7dad7206 reste historique et ne le qualifie pas. Aucun changement du runner isolé canonique, du parcours de paiement ou de la voix en direct n’est réalisé par cette propagation.


## Propagation du Q12 final intégrant F1/diagnostics — 18 octobre

Merge local normal du head Q12 `d29619e58827310759934485222806214462c8ba`, lui-même issu du F1 final `064a66e95649bf6362232bb69201edf57d24e321`. Aucun conflit ; union des commandes workflow des deux parents et ancêtre runtime/voix359 vérifiés. La chaîne de tests Gateway est conservée et prolongée par le test Q13 de staging média, pas remplacée. Autorité People, queue, transport privé et frontière Q13 restent aux propriétaires existants ; aucun bail playbooks ou runner isolé modifié.

Ciblés hors téléphone :38/38 accès QA People,13/13 pièces par le canal privé,4/4 pipe Graph privé, ingress privé,12/12 diagnostics propriétaire et compilation TypeScript verts. Ces contrats/captures/fixtures ne revendiquent aucun envoi, redémarrage, geste ou recette S24. La CI complète du nouveau head n’a pas été lancée. L’ancienne142/142 sur7dad7206 est historique ; les têtes intermédiaires75f8 et le nouveau head ne sont pas qualifiés par elle. PR en brouillon, intégration/publication playbooks et CI complète encore attendues.

## Phrase de cause Q13 (relecture Claude du 19/10)

Après la fusion de la ligne runtime, qui contient #325, la CI canonique de `6f1cc973` a échoué à l'étape 44 du job `mobile-ui-plugin`. Le contrôle des causes typées exige une phrase rendue pour chaque code produit, et Q13 émet `qa_ingress_deadline_exceeded`. Les phrases FR/EN sont ajoutées dans le propriétaire existant `FAILURE_PHRASES`. Aucun changement de budget ni de comportement.
