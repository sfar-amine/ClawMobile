# V3 — outil de requalification duplex avant RDV1

Outil local sans réseau/S24 : entrée de preuves externes alignées, empreinte et route comparées exactement, rapport de couverture/manques/miss/faux positifs et cutMs observés. Une couverture complète permet au plus une proposition propriétaire ; un miss ou faux positif l’interdit. Aucun gate, fichier qualifiedRoutes ou route audio n’est modifié.

CLI bornée8Mio, JSON fini, sortie nouvelle créée exclusivement sans écrasement des preuves/profils. Tests9/9 et CI couranteaf4132a entière rejouée, ci.yml inchangé. Pas de nouvelle preuve acoustique : Amine/Claude restent responsables de la mesure, du build réel et de la décision RDV1.
