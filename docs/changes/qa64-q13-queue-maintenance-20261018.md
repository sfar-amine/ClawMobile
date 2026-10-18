# Q13 — Réveil borné dans le cycle health-manager existant

Le cycle normal de `samantha-health-manager.sh` appelle le propriétaire privé fixe `people-trusted.py qa-queue-tick`. Pas de nouveau timer, processus permanent, scheduler, route, store ou résolveur. Le propriétaire People résout la racine playbooks selon son propriétaire existant ; l’entrée QA reste fermée tant que `integration_pending` n’est pas levé par la qualification du protocole.

Le hook recontrôle le mode canonique juste avant l’appel : tout mode autre que normal, dont emergency_stop, l’empêche. Un seul appel par cycle, aucun retry. `timeout --kill-after=1 14` borne le helper à 14s plus 1s maximum d’arrêt ; une réponse de plus de 4096 octets est refusée. Le DTO fermé ne contient que state, dispatched (0 ou1), waiting (0..500). STARTED exige dispatched=1 ; un autre état ne peut prétendre à un départ. Les erreurs, stdout/stderr bruts, numéros, contacts, corps et détails privés ne sont jamais journalisés.

Le journal existant reçoit seulement un état fermé et des compteurs lors d’un changement. Les ticks NOT_READY identiques restent silencieux. Ce hook ne sélectionne pas de campagne et ne relance pas d’effet : les fences, l’autorisation courante, l’empreinte serveur d’admission, la terminaison NOT_DISPATCHED prouvée, les ACK Q12 et la réservation UI restent dans leurs propriétaires People/QA/Bridge.

## Vérification

Six tests exécutent la vraie fonction shell extraite du health-manager avec des fixtures propriétaires temporaires : pending et absence de répétition des logs, modes non normaux, un départ maximum, refus de DTO privés/incohérents, volume borné, échec sans retry et timeout réel d’un helper bloqué. Le descripteur du verrou health9 est fermé dans le helper. Les tests sont inscrits dans le workflow existant. Aucune exécution du health-manager complet ni du S24 ; fixtures explicitement synthétiques, aucun worker ni réseau.

Base core qualifiée Q12 : commit `6cdf850dbfcb5bca526c0127d82171be01fa6beb`. Le contrat People/PB et son integration_pending sont une dépendance distincte du hook ; aucune activation ni recette physique n’est revendiquée.

## Retour arrière

Revert du raccord. Aucun état métier créé ou migré ; les champs de statut utilisent le propriétaire de santé existant.
