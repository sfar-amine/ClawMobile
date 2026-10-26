# ADR — Suivi d’un tour admis par son transport Gateway existant

Statut : proposé dans L0bis de la refonte du 25 octobre 2026 ; activation soumise à la CI canonique et à la recette S24.

## Constat et décision

Le tour S24 `run_1792934450703_597aff20` est admis P1 sur le SDK WebSocket public, avec zéro appel d’outil et 4,382 s de modèle. L’admission précède `session.started` de 21,798 s. Les lectures répétées `sessions.list` / `chat.history` chargent le même Gateway ; le diagnostic de latence les distingue de la préparation des plugins et de la livraison audio.

Conserver la connexion `ownerTurnGateway` de ce tour avec `GatewayClient.request(agent, {expectFinal:true})`. Le SDK installé 2026.9.6 ignore l’ACK `accepted` dans ce mode et retourne le résultat terminal. Son `onEvent` fournit seulement l’avancement titré des outils du même `runId` et de la même `sessionKey`, avec séquence croissante. Les fragments assistant et les événements lifecycle ne prouvent jamais une action accomplie.

Le registre `runs.json`, sa sérialisation atomique et son SSE existants restent les seuls propriétaires de la projection. La page Conversations suspend son rafraîchissement de métadonnées pendant un tour suivi et sert l’index existant. Aucun nouveau store, abonnement global, routeur, pool d’autorité, planificateur ou moteur de retry n’est créé. L’API et le budget métier voix de 30 s ne changent pas.

## Admission, bornes et perte de transport

Le ticket P1 est encore vérifié après chargement du SDK, avant connexion et au HELLO juste avant l’envoi. Le transport conserve les scopes existants et une unique méthode `agent`. Le `runId` reste la clé d’idempotence. Aucun repli CLI ni second envoi n’est admis après émission.

Au plus 8 observations actives, 120 s de suivi par requête (puis fermeture bornée du SDK), 48 événements retenus et 48 écritures d’avancement en attente. Une saturation refuse avant l’envoi ; elle ne réexécute rien. Les échecs prouvés avant envoi libèrent leur observation. Le résultat final est borné à 32 K caractères ; les titres à 160 caractères. Les cartes utilisent `progressCard.get` seulement après l’événement de leur outil écrivain, avec le cache et le contrôle de fraîcheur existants.

Une perte après émission reste `unknown`, jamais « rien exécuté ». Une époque de processus distingue les suivis interrompus après redémarrage du Companion. Le propriétaire existant `listEnrichments` déduplique une réconciliation par tour et par époque, budget global 5,5 s, réponse locale sous 1,5 s : lecture de session exacte puis historique au besoin. Une preuve exige une demande unique dans l’historique et les runs retenus de cette session, une date de départ à moins de 30 s de l’admission, tous les outils terminés et un dernier message assistant terminal `stop`. À défaut, le résultat demeure inconnu. Ni absence de session ni simple texte de progression ne prouve une fin. Aucun tour n’est rejoué et aucune reconnexion ne resoumet `agent`.

Cette première étape ne promet pas de suivre indéfiniment une tâche dépassant la borne, ni de livrer une réponse terminale manquante après une réconciliation infructueuse. La recette mesure aussi cette limite, sans faux succès. Le partage futur d’une connexion ne peut élargir l’admission P1. La migration du chargement froid, la maintenance SQLite, la rétention et le streaming audio appartiennent à leurs propriétaires existants et restent séparés.

## Vérification et retour arrière

Fixture native nettoyée : `fixtures/s24-2026-10-25-gateway-observation/native-timing.json`. Le contrat est confronté aux modules SDK réellement installés sur le S24 ; les frames unitaires sont explicitement construites depuis ce code et ne sont pas présentées comme une capture WebSocket. Tests d’admission P1, d’observation, de duplication/session étrangère, de rafale, de perte/redémarrage et de borne capacité inscrits en CI. La recette après déploiement doit conserver le résultat terminal et les métadonnées du seul tour public testé, compter les lectures Gateway et comparer chaque segment de latence séparément.

Retour arrière : redéployer le SHA précédent par `companion-deploy.sh`. Les nouveaux champs optionnels du registre sont ignorés par l’ancien code. Ne jamais rejouer les tours incertains après ce retour arrière. Paiements, confirmations humaines et ACL contacts inchangés.
