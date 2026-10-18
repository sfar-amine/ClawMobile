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
