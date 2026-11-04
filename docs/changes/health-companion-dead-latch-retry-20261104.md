# Companion mort : relance lente au lieu d'un blocage définitif

## Pourquoi

Après 3 relances en une heure, puis un retour arrière Tier0, le gestionnaire de santé passe un service en
`human_required`. `restart_gate` refuse alors toute relance tant que le service n'a pas été stable 10 minutes.
Un Companion **arrêté** ne peut jamais atteindre cette stabilité : il reste mort jusqu'à une relance faite à la
main. Le pont Claw, qui tourne dans le Companion, tombe avec lui.

C'est arrivé deux fois sur le S24 le 03/11 :
- à 19 h 03, après un redémarrage du téléphone ;
- vers 22 h 05, après une soirée de déploiements.

Les deux fois, il a fallu taper la relance dans Termux.

## Ce qui change

Uniquement pour le Companion, et uniquement quand son processus est absent, le gestionnaire tente une relance au
plus toutes les `HEALTH_LATCHED_RETRY_S` secondes (900 par défaut), sous la même lease.

Ce qui ne change pas :
- l'escalade humaine reste ouverte ;
- un Companion vivant garde le verrou et n'est jamais remplacé sans l'IA ;
- les autres services gardent le comportement actuel.

## Limites

- Une seconde piste n'est pas prouvée : le mode « déploiement » vu à 21 h 51 alors que le déploiement était
  terminé. Le 04/11 à 09 h 08, aucun processus ne tenait `companion-deploy.lock`.
- Un Companion vivant mais en mauvaise santé suit toujours le verrou.
