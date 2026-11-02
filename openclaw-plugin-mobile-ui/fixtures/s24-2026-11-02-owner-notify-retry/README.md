# Notifications propriétaire WhatsApp — tempête de reprises (S24, 02/11/2026)

Captures en lecture seule par `claw_exec`, nettoyées, utilisées par
`installer/termux-lite/test-owner-notify-retry.py`.

- `whatsapp-outbound-cleaned.log` : 191 lignes réelles de `~/.openclaw/health/whatsapp-outbound.log`
  (sha256 `98d3d423cd7e81df03dc05199435587c17e7b321cb62f67969cb41f9c4213eeb`), pour quatre clés :
  - `incident-f73a069c49edd4cf` : les 40 premiers échecs (04/10, toutes les ~5 min après 3 essais rapprochés) et les 3 dernières lignes (acceptée le 02/11 à 17:19) ;
  - `incident-1fc6c7a375679b3a` : ses 109 échecs, jamais acceptée ;
  - `incident-25c564165b64d057` : 24 lignes d'une clé acceptée de nouveau à chaque cycle RDC ;
  - `recovery-bc6233b9cb8d7d623f2f0840` : ses 15 lignes, dont 8 acceptations de la même clé et l'échec de 17:22:32.
- `capture.json` : décomptes sur tout le journal (2138 échecs, 26 clés, 10 finalement acceptées, 16 jamais, 95 clés acceptées), preuve que la même clé a été acceptée avec des identifiants de message distincts, et extrait du journal Gateway de l'échec du 02/11 17:22:32 (`UNAVAILABLE`, « No active WhatsApp Web listener »).

Nettoyage : aucun numéro, corps de message, compte ni jeton. Les identifiants de message WhatsApp sont remplacés par `mid-NNNN` (deux identifiants distincts restent distincts) ; les pairs du journal Gateway par `<num>`. Les clés sont des empreintes (`sha256` tronqué) et ne révèlent pas le contenu.
