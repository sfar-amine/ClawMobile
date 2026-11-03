# Nuits hors ligne du S24 et journal Gateway tronqué — 2 novembre 2026

## 1. Wi-Fi coupé la nuit (26/10, 28/10, 29/10)

Constat (S24, lecture seule, 02/11) :
- `health.log` : `wifi_disabled_without_lease` à 23:34 (26/10), 23:08 (28/10) et 23:39 (29/10), levé à 07:46, 08:47 et 09:09. Aucun bail, `action=none`. SMTP et WhatsApp tombent dans les minutes qui suivent.
- `dumpsys wifi` (depuis le redémarrage du 27/10) : les coupures de nuit viennent de `com.android.systemui` (uid 10049), écran allumé. Aucune bascule shell (uid 2000) : aucun `svc wifi` de Samantha.
- Téléphonie : à moins d'une seconde d'intervalle, les **données mobiles** sont aussi coupées par `com.android.systemui`, `reason=USER` (28/10 23:08:04, 29/10 23:39:16). Le matin, les deux reviennent ensemble (29/10 08:47:01, 30/10 09:09:08).
- Le S24 était donc **entièrement hors ligne** 8 à 10 h. D'où SMTP en panne et 621 des 625 échecs d'envoi WhatsApp propriétaire.
- En journée, le Wi-Fi est aussi coupé et rallumé par le système (uid 1000, demande de connexion par `com.android.settings`). C'est le Wi-Fi automatique Samsung (`sem_auto_wifi_control_enabled=1`). La 4G reste alors active : aucun impact.

Cause : un réglage côté Android, pas du code Samantha. La paire Wi-Fi + données mobiles est coupée par l'interface système à l'heure du coucher, à moins d'une seconde d'intervalle, et rallumée de la même façon au réveil. Cela correspond à un mode ou une routine Samsung (mode Sommeil de « Modes et routines ») qui coupe ces deux boutons du panneau rapide, ou à deux appuis manuels.

À faire par Amine sur le S24 (aucun changement fait par Samantha) :
- Réglages > Modes et routines > Modes > Sommeil (et l'onglet Routines) : retirer les actions « Wi-Fi désactivé » et « Données mobiles désactivées », ou au moins garder une des deux.
- S'il coupe ces boutons à la main avant de dormir : garder au moins le Wi-Fi ou les données mobiles actifs pour que Samantha reste joignable.

Correctif (détection seulement) :
- Le garde `android-network-mutation-guard.py check`, déjà lancé à chaque cycle santé, suit l'épisode « Wi-Fi coupé sans bail » dans un seul fichier borné (`~/.openclaw/network-mutation/wifi-unmanaged-episode.json`).
- Le reçu `network-mutation-safety.json` reçoit `wifi_unmanaged` : début, durée, données mobiles, mode avion, hors ligne ou non.
- Quand le Wi-Fi et les données mobiles sont coupés (ou que le mode avion est actif), il ajoute aussi l'avertissement `device_offline_wifi_and_mobile_data_off`.
- Après 15 min hors ligne, **une** notification par épisode passe par la file existante (`incident-notify.sh info`). Elle est livrée dès le retour du réseau, avec une seule ligne dans `health.log`.
- Le Wi-Fi seul coupé avec la 4G active (Wi-Fi automatique en journée) ne donne qu'un reçu, sans alerte.
- **Jamais de réactivation automatique.** Le garde et le gestionnaire de santé l'interdisent déjà : le Wi-Fi coupé sans bail peut être un choix d'Amine. Les données mobiles ne sont jamais touchées. La règle Orange « 4G et Wi-Fi » (17/10) est inchangée.

## 2. Journal Gateway tronqué à chaque démarrage

Constat (S24, lecture seule, 02/11) :
- La première ligne de `companion-openclaw-gateway.log` est `--- OpenClaw gateway start 2026-11-02T19:24:56.857Z ---`, écrite par le redémarrage du déploiement de 20:22.
- Les archives `.1` à `.3` (4 Mio chacune, 0600) laissent des trous qui commencent tous à un redémarrage. Les intervalles perdus sont, en UTC :
  - 01/11 10:55 – 23:19 ;
  - 02/11 08:01 – 16:13 ;
  - 02/11 16:13 – 19:24.

Cause : `startRuntimeInternal` écrivait l'en-tête avec `fs.writeFileSync(logPath, …)`, dont le mode `"w"` vide le fichier. Chaque démarrage effaçait donc l'exécution précédente avant que la rotation ait pu l'archiver. `gateway-start.sh`, `lib.sh`, `run.sh` et `companion-deploy.sh` n'écrivent pas dans ce fichier.

Correctif :
- Le journal est ouvert en ajout seul (`O_APPEND|O_CREAT|O_NOFOLLOW`, 0600), l'en-tête est ajouté puis le même descripteur est donné à la Gateway.
- La borne reste au propriétaire existant `gateway-log-retention.py` (cycle santé) : 4 Mio par fichier, 3 archives, même inode conservé. Aucun nouveau rotateur.

## Tests (inscrits dans `.github/workflows/ci.yml`)
- `installer/termux-lite/test-wifi-night-offline.py` : rejoue les preuves du S24 et la nuit du 29/10 (notification unique à 15 min, aucune bascule), le cas de jour (reçu seulement), la reprise des données mobiles et l'échec de la file.
- `openclaw-plugin-mobile-ui/scripts/test-gateway-log-append.cjs` : trois démarrages réels de `startRuntime` gardent l'exécution précédente octet pour octet sur le même inode ; la rotation bornée garde 3 archives sous le plafond. Le test échoue sur l'ancien code.

Fixtures : `openclaw-plugin-mobile-ui/fixtures/s24-2026-11-02-wifi-night-offline/` et `…/s24-2026-11-02-gateway-log-truncation/`, captures S24 du 02/11 nettoyées (sans SSID, MAC, IP ni identifiant).

## Retour arrière
Revert de ce commit puis redéploiement par `companion-deploy.sh <commit>` :
- le garde revient à l'avertissement seul ;
- `wifi-unmanaged-episode.json` peut être supprimé sans effet ;
- la Gateway retrouve l'ancien comportement (troncature au démarrage).

Aucun réglage Android n'est modifié par ce lot ; rien à restaurer sur le téléphone.
