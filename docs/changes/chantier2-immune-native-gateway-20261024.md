# Chantier 2 : utiliser le propriétaire natif des credentials

La qualification réelle de Luna via la passerelle existante réussit en2,7s,
alors que le one-shot isolé refuse les profils OAuth. Le circuit immunitaire
réutilise donc `api.runtime.llm.complete` et la route loopback propriétaire
existante, avec un contrat technique distinct `samantha.engineering.immune`.

Le gouverneur Python reste propriétaire du choix Sol puis Luna et des budgets.
Le port exige un seul de ces deux modèles, impose OAuth et ne fait aucun repli.
Il ne crée ni agent, session, outil, commande, credential ni nouvelle route.
Le contrat C1 conserve Gemini/Luna, sa limite et son refus de Sol. Le whitelist
du plugin ajoute Sol uniquement pour servir le nouveau contrat interne ; aucun
choix de profil d’authentification ou d’agent n’est admis. Déployer le fragment
natif de configuration versionné avec le propriétaire de configuration existant.

Le code d’ingénierie a une sortie JSON bornée64kcaractères et une échéance90s ;
les limites C1 restent inchangées. Les prix catalogue restent des estimations,
jamais des factures ou une preuve de consommation gratuite.

Build et tests du port existant passent avec fixtures explicites. CI canonique
exacte hors S24 obligatoire avant déploiement, puis recette Sol/Luna réelle.
Luna seul a été qualifié avant ce lot ; aucun PASS Sol ni reprise autonome n’est
inféré. Retour par companion-deploy vers la paire compatible, conservation des
dossiers/budgets. Les anciens appels inconnus ne sont pas rejoués.
