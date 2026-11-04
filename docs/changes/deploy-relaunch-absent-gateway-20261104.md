# Déploiement : relancer une Gateway absente au lieu d'attendre (04/11/2026)

**Incident S24 du 04/11** (déploiement de `3413f27a`) :
- à 09:57, la Gateway s'arrête sans ligne d'arrêt, alors que le téléphone est chargé ;
- toutes les 15 s, le chien de garde du Companion tente de la relancer et se fait refuser : « Runtime lock is held by another operation », le verrou étant tenu par le déploiement ;
- pendant ce temps, le déploiement attend une disponibilité qui ne peut pas venir : `gateway_not_ready`, puis `rollback_failed` ;
- la Gateway ne revient qu'avec le retour arrière (de nouveau en ligne à 10:13:58).

**Correctif :** pendant un déploiement, `runtime-sync.sh` vérifie à chaque attente si la Gateway est absente : le fichier pid du Companion ne désigne aucun processus `openclaw-gateway` vivant, et `healthz` ne répond pas. Si c'est le cas, il la relance une seule fois par le propriétaire existant `--deploy-restart`, avec le verrou hérité, puis l'attend.
- Une Gateway vivante mais encore en démarrage est attendue, jamais relancée.
- Hors déploiement, rien ne change.

**Limite :** la cause de l'arrêt de 09:57 n'est pas prouvée (probablement Android sous pression mémoire).

**Retour arrière :** revert.
