# Captures Android réseau — S24, 11/10/2026 (lecture seule)

- Capturées le 2026-10-11 vers 16:50 (heure S24) par Claude via `claw_exec`, en lecture seule (`adb -s 127.0.0.1:5556 shell dumpsys connectivity`, `cmd wifi status`). Aucune mutation.
- Situation réelle d'Amine : dehors en 4G, Wi-Fi activé mais connecté à aucun réseau ; réseau par défaut = cellulaire validé.
- Nettoyage : adresses IP, DNS, routes, `handle` et `AdminUids` remplacés par `REDACTED`/`0` ; préfixe tronqué à l'en-tête et au réseau par défaut ; liste des UID suivis raccourcie.
- Utilisées par `installer/termux-lite/test-android-network-mutation-guard.py` (décision « ne pas toucher au Wi-Fi »). Le cas « Wi-Fi réseau par défaut » est dérivé de la même forme (transport `WIFI`), faute de capture possible sans muter le réseau.
