# gateway-preflight : verrou de configuration OpenClaw 2026.10.9 reconnu (01/11/2026)

## Incident
Le 01/11 vers 22:35 UTC, le retour arrière du déploiement `9862fd25` a arrêté la Gateway 10.9.

Ensuite, chaque démarrage a échoué avec `gateway lock preflight refused recovery: count 0, config_lock_ambiguous`. Pourtant, le propriétaire du verrou (PID 7574) était mort et le port 18789 fermé.

La Gateway est restée arrêtée jusqu'à ce que les deux verrous périmés soient mis en quarantaine à la main.

## Cause
- En 2026.10.9, le verrou de configuration s'appelle `state.<hash>.lock`, sans fichier `.sqlite` associé.
- En 2026.9.x, il s'appelait `gateway.<hash>.lock`.
- `stale_gateway_lock_status` ne cherchait que `gateway.*.lock`.

## Correctif
Les deux noms sont reconnus. `gateway.state.lock` reste exclu des candidats.

Le reste du contrôle est inchangé :
- identité (pid, ownerId, startTime) ;
- âge du verrou ;
- propriétaire vivant ;
- Gateway active ;
- écoute sur le port ;
- quarantaine réversible.

## Tests
`test-gateway-preflight.py` :
- disposition 10.9 récupérée ;
- propriétaire 10.9 vivant jamais réclamé ;
- les deux dispositions pour une même configuration restent ambiguës.

Les nouveaux tests échouent sur le code précédent.

## Fixtures
`openclaw-plugin-mobile-ui/fixtures/s24-2026-11-01-gateway-lock-1009/`.

## Retour arrière
Revenir sur ce commit, puis lancer `companion-deploy.sh` vers le commit précédent.
