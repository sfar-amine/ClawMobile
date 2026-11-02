# WhatsApp sans écouteur actif — S24, 28/10–02/11/2026

Captures en lecture seule par `claw_exec`, nettoyées, utilisées par
`installer/termux-lite/test-whatsapp-listener.py`.

- `gateway-whatsapp-timeline.log` : 84 lignes réelles du journal Gateway
  (`~/.openclaw/workspace/logs/companion-openclaw-gateway.log*`, codes ANSI retirés) : démarrages du
  Gateway et du fournisseur WhatsApp, fermetures 408/428/503, reprises du chien de garde (499), retrait
  forcé du plugin au rechargement de config du 02/11 16:22 UTC et refus `send` UNAVAILABLE. Les lignes du
  02/11 16:13–18:21 UTC viennent d'une première capture (20:0x locale) : le redémarrage du Gateway de
  20:24 a tronqué ce journal.
- `health-whatsapp-20261102.log` : les 85 lignes `service=whatsapp` du gestionnaire de santé du 02/11
  16:11–20:01 (sha256 identique à la source après nettoyage), avec les fausses coupures
  `channel_not_connected` et le verrou `latest_outbound_failed`.
- `capture.json` : mesures de la sonde `openclaw channels status` (9,3 à 11,3 s pour un budget de 8 s),
  lignes d'état réelles, faits du code OpenClaw 2026.10.9 installé (politiques de reprise, `channels.start`,
  enveloppe d'erreur JSON de la CLI), statistiques des coupures sur 7 jours et du registre d'envoi.

Nettoyage : aucun numéro, corps de message, compte ni jeton. Identifiants d'incident et de corrélation
remplacés par `<id>`, numéro du fournisseur par `<num>`. Les lignes d'envoi (`Sending/Sent message`) et
de routage ne sont pas reprises. L'enveloppe d'erreur JSON de la CLI est reconstruite à partir du code
OpenClaw installé (`call-*.mjs`) et du message réel du journal Gateway : aucun envoi n'a été fait pour la
capturer.
