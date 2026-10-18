# Consultation Orange en voix : le garde reconnaît enfin sa propre ligne de commande

## Constat (S24, 18/10, lecture seule)
À 14:53, « mon solde avec tous les détails » à la voix : capability `telecom.orange.consultation`, route déterministe `orange.summary.maxit.v1`, puis `preferred_route_failure` avec `{'ok': False, 'source': 'maxit_network_guard', 'state': 'guard_unavailable'}`. Le reçu n'a pas de bloc `network_guard` : le refus vient du contrôle d'identité de `_with_consultation_receipt_locked`, avant toute action réseau.

## Cause
`canonical_consultation_owner` vérifie que le processus est bien `garde with-consultation-receipt -- python -m telecom.maxit_guarded_service …`. Il ne retirait que `--no-cellular-channel`. Depuis le 17/10 (`claude-orange-voice-keep-wifi-20261017`), la voix en direct passe `--keep-wifi` : la ligne vocale était refusée à chaque fois. Les tests remplaçaient ce contrôle par `True`, d'où l'absence de détection.

## Correctif
`canonical_consultation_argv` (pure) : les options de consultation connues, chacune au plus une fois et dans n'importe quel ordre, puis la forme exacte attendue. Doublon, option inconnue, autre module ou autre chemin de garde restent refusés.

## Tests
`test-consultation-voice-keep-wifi.py` : nouveau cas sans substitution, sur la ligne exacte construite par `telecom/maxit_guarded_service.run_with_wifi_off_guard`. L'ancien code refuse cette ligne (reproduit).

## Retour arrière
Revert du commit.
