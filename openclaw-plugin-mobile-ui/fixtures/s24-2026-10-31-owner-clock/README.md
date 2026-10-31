# Horloge des tours propriétaire — 31/10

Modules publics du SDK 2026.9.6, compressés (`provenance.json`). Le test exécute leurs fonctions exactes, sans modèle, réseau ni appareil :
- la section « Temporal Context » du prompt système ne donne que la date et renvoie à `session_status` pour l'heure ;
- le format d'enveloppe `[DOW AAAA-MM-JJ HH:MM TZ]` du SDK ;
- l'horodatage à la frontière du modèle, qui garde une enveloppe déjà présente. Il vient du module `builtin` du fixture `s24-2026-10-26-gateway-prep-stages`, identique au S24.
