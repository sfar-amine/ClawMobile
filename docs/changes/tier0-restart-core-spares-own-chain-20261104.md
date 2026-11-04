# Tier0 : la relance des superviseurs ne se tue plus elle-même (04/11/2026)

**Défaut trouvé pendant l'enquête sur l'incident S24 du 04/11, 12:53** : juste après l'activation par Tier0 de la version 20261104T125241, les superviseurs sont arrêtés par SIGKILL (onglet Termux : « Process completed (signal 9) »). Le déploiement de `d8e08d9b` s'arrête sans reçu, et le téléphone reste hors ligne.

**Cause dans le code** : `restart_core` vise tous les descendants des superviseurs, y compris son propre planificateur et le shell chargé de la relance. Quand la relance est demandée depuis l'intérieur de l'arbre des superviseurs, elle se tue avant de relancer. C'est le cas du retour arrière du chien de garde de soak : le chien de garde est un enfant du gardien. Par ailleurs, sous `set -e`, un dépassement de délai sur un verrou sautait aussi la relance.

**Correctif :**
- La relance épargne sa propre chaîne de processus, hors superviseurs : planificateur, shell de bootstrap, chien de garde, déploiement.
- Les superviseurs et leurs autres descendants sont toujours arrêtés, enfants d'abord.
- La relance a lieu même si l'attente d'un verrou dépasse le délai. Chaque superviseur garde son propre verrou d'unicité.
- Chaque relance écrit une ligne `event=restart_core` dans `continuity/boot.log` (nombre de processus arrêtés et épargnés).

**Ce n'est pas la cause de la coupure de 12:53.** Traces lues sur le S24 à 14:15 : tous les processus Termux ont été tués à plusieurs reprises par SIGKILL ; les superviseurs sont repartis de zéro à 12:58, 13:15, 13:42, 13:58 et 14:13. Depuis le redémarrage du 03/11, le Wi‑Fi et l'ADB sont coupés : la limite des processus fantômes, que le gestionnaire de santé remontait à 128, est revenue à 32, et c'est le tueur de processus fantômes d'Android qui agit.

**Retour arrière :** revert, puis réinstaller le contrôle Tier0.
