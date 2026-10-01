# Projection des incidents terminaux

Le ledger canonique `~/.openclaw/incidents/orchestrator.db` reste immuable du point de vue de l'audit : un incident terminal `failed` n'est ni supprimé ni réécrit lorsque le composant récupère plus tard.

`health-verdict.py` distingue désormais l'historique d'audit de la vue opérationnelle :

- un `failed` de moins de 24 h reste dans `recent_failed` tant qu'aucune preuve live saine n'existe ;
- si la capacité correspondante est actuellement `healthy` ou `ready`, l'ancien `failed` n'est plus projeté dans `recent_failed` ;
- pour Slack Bridge, la preuve doit être `state=healthy`, `connected=true` et le heartbeat doit dater de 120 secondes ou moins ;
- une preuve dégradée, absente, future ou périmée ne masque jamais l'incident.

Cette règle nettoie la vue opérationnelle sans perdre la RCA, les événements, les Learning Gate ou les références d'incident.

Validation live avant publication : les six anciens échecs récents (WhatsApp x2, Remote Desktop Commander, Gateway, Slack Bridge et SMTP) disparaissent de la projection corrigée tandis que les six lignes restent présentes dans le ledger.
