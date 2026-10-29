# Santé WhatsApp : un envoi plus récent du canal efface un échec plus ancien — 29 octobre 2026

S24, 29/10 :
- Le réseau est revenu à 08:47 (heure de Tunis).
- À 08:48:32, l'envoi WhatsApp du message de fin d'incident a échoué ; le message est parti par e-mail.
- Le canal a ensuite envoyé normalement à 08:51, mais rien de plus récent n'a été inscrit dans `health/whatsapp-outbound.log`.
- WhatsApp est donc resté « degraded » (`latest_outbound_failed`) pendant des heures, alors qu'il était connecté.

Correctif : si `openclaw channels status` indique un envoi (`out: … ago`) postérieur à l'échec enregistré, cet échec ne compte plus. Sans ce champ, ou si l'échec est plus récent, la règle précédente s'applique.

Retour arrière : revert puis redéploiement du core.
