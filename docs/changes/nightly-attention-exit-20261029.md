# Recette nocturne : une « attention » n'est plus un échec du job — 29 octobre 2026

S24, 29/10 : aucun reçu de recette nocturne le 28/10 ni le 29/10. Le planificateur OpenClaw avait désactivé le job `samantha:nightly-acceptance` le 27/10 à 03:01, après 10 échecs consécutifs (`consecutive-failures`). En réalité, chaque nuit se terminait sur « attention », avec 11 dérives de latence, et le script sortait alors en code 1. Le rejeu des conversations ajouté le 28/10 n'a donc jamais tourné.

Correctif : sortie `0` pour un reçu `ok` ou `attention`, `1` seulement pour `failed`. Le constat reste dans le reçu et dans la santé. Le job désactivé est réactivé sur le S24.

Retour arrière : revert puis redéploiement du core.
