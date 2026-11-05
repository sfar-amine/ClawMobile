# Gestionnaire de santé : un épisode de refus sans heure de début en reçoit une (05/11/2026)

## Pourquoi
Après le déploiement de 21:16 (#548), `core_services_watchdog` et `incident_manager` sont restés absents. Leur épisode de refus avait été ouvert par la version précédente (#547) : la marque `admission=refused` existait, sans heure de début.

Le compteur prenait alors « maintenant » comme début à chaque passage. Les 15 min n'étaient donc jamais atteintes, et le démarrage direct prévu par #548 ne partait jamais.

## Ce qui change
Si l'heure de début manque, elle est enregistrée au premier refus vu, puis n'est plus touchée tant que l'épisode dure. Le démarrage direct part 15 min plus tard, comme prévu.
