# Préchauffe du cerveau : après la promotion, jamais au démarrage de la Gateway (30/10/2026)

Le déploiement de 986187b7 sur le S24, le 30/10 à 10:50, a échoué : la promotion Tier0 est restée en
`activation_readiness_failed` et le déploiement est revenu à 730ff3e1. Le tour de préchauffe lancé par
`gateway-start.sh` a bloqué la Gateway 61 s juste après son démarrage (« liveness heartbeat delayed »). Le
gestionnaire de santé n'a redémarré qu'après la fenêtre de 120 s où Tier0 attend la santé des composants critiques.

`gateway-start.sh` ne lance plus la préchauffe. Seul `companion-deploy.sh` l'appelle, après la promotion et avant
les cinq parcours. Hors déploiement, le premier tour du cerveau après un redémarrage de la Gateway reste froid,
comme avant 986187b7.
