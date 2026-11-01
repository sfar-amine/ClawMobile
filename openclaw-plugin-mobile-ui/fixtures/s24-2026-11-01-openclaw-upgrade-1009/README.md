# Reçus réels de la répétition de bascule OpenClaw 2026.9.6 → 2026.10.9 (S24, 1er novembre 2026)

Reçus écrits par `installer/termux-lite/openclaw-upgrade.py --profile staging` sur le S24 :
- racine `~/.openclaw-android/staging/upgrade-rehearsal`, port 19789 ;
- chaque passe part d'une copie fraîche en vraie taille des bases de prod, faite par l'API de sauvegarde SQLite en ligne, sans arrêter la prod (20 bases, 297 Mo) ;
- `credentials/` n'est pas copié, les canaux sont coupés et le cron aussi.

Nettoyage avant commit : chemins sous le home abrégés en `~`, empreintes SHA256 des sauvegardes, chemins de journaux et dossier de sauvegarde retirés. Le reçu ne contient aucun contenu de config ni aucune sortie brute.

`receipts.json`, dans l'ordre :

| passe | issue | ce qu'elle montre |
|---|---|---|
| `20261101T162000` | `rolled_back` | `plugins update` refusé sous Android (fs-safe, `/data` à l'uid 1000) ; vrai retour arrière, santé, tour et intégrité de la 9.6 |
| `20261101T163827` | `rollback_failed` | Worker egress des secrets indisponible au démarrage 10.9, triage automatique lancé. La 9.6 restaurée répond (santé, tour), mais la gate WhatsApp de préproduction échoue : enregistrements de plugin encore orientés vers la prod |
| `20261101T172851` | `rolled_back` | (b) retour arrière avec `rollback_node: keep` : la 9.6 répond sous Node 24.22.2 sur des bases restaurées |
| `20261101T174046` | `rolled_back` | 10.9 : tour agent OK, WhatsApp 2026.10.9 chargé ; gate outils (inspection statique) en échec, puis retour arrière |
| `20261101T175913` | `deployed` | (a) chemin nominal complet, toutes les gates vertes (42 outils au runtime) |

Préproduction seulement, non reproduit en prod :
- `secrets.egressProxy` est retiré de la copie depuis la passe 165446 pour isoler ce blocage ;
- les enregistrements de plugins (`config_machine_state`) et les liens « peer » des projets npm sont réorientés vers la racine de préproduction depuis la passe 172851.

Utilisé par `installer/termux-lite/test-openclaw-upgrade.py` (classe `RealReceipts`).
