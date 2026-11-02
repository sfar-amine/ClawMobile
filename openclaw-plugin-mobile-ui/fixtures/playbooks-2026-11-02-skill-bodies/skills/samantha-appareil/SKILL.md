---
name: samantha-appareil
description: Téléphone S24 via samantha_device_assistance : réglages, son, écran, applis, capture, photos, SMS.
---
# Téléphone S24 — outil typé d'abord

L'outil `samantha_device_assistance` est présent dans tes outils. Appelle-le directement, une seule fois, avec l'action et ses paramètres typés. Jamais de commande shell, d'`adb` ni de `termux-*` pour ces demandes : l'outil fait la même chose en une à deux secondes et relit l'état.

## Exécutées tout de suite, puis annoncées (décision d'Amine du 31/10)
- `device.torch.set` `{on}` : torche.
- `device.dnd.set` `{on}` : Ne pas déranger.
- `device.timer.start` `{seconds, label?}` : minuteur (convertis la durée en secondes).
- `device.timer.cancel` `{all?}` : annuler ou arrêter le minuteur, sans ouvrir l'Horloge. S'il y en a plusieurs, la réponse les énumère et demande ; rappelle avec `all: true` seulement si Amine dit de tous les annuler.
- `device.alarm.set` `{hour, minute, label?}` : alarme (heure locale, 24 h).
- `device.settings.open` `{page}` : une page des réglages de la liste fermée (wifi, bluetooth, airplane, connections, mobile_network, data_usage, display, sound, battery, battery_saver, location, nfc, date_time, apps, storage, security, accessibility, home).
- `device.volume.set` `{stream: media|ring|alarm, percent? 0..100 | direction? up|down}` : un seul de percent ou direction.
- `device.brightness.set` `{percent? 1..100 | direction? up|down | auto? bool}` : exactement un des trois.
- `device.ringer.set` `{mode: normal|vibrate|silent}` : sonnerie normale, vibreur, silencieux.
- `device.battery_saver.set` `{on}` : économie d'énergie.
- `device.bluetooth.set` `{on}` : Bluetooth.
- `device.wifi.enable` : rallumer le Wi-Fi.
- `device.app.open` `{app}` : ouvrir une appli de la liste fermée (whatsapp, maxit, camera, gallery, calendar, messages, phone, clock, calculator, chatgpt, gemini, chrome, youtube, maps, settings, samantha).
- `device.screenshot.take` : capture d'écran enregistrée dans la Galerie.

Pas de récapitulatif ni de confirmation pour ces actions. Reprends la phrase de la réponse (« Torche allumée. ») sans rien inventer.

## Lectures
- `device.status.read` : batterie, Wi-Fi, Bluetooth, volume média.
- `device.torch.read`, `device.dnd.read`, `device.alarm.next`.
- `device.photos.today` `{day?: today|yesterday}` : nombre et heure des photos.
- `device.sms.latest` `{count?: 1..5}` : derniers SMS reçus, en entier, codes compris (décision d'Amine du 31/10). Lis-les à Amine ; ne les recopie dans aucune mémoire, note, journal ni message à un tiers.

Une lecture vide dit « rien » (« Aucun SMS reçu. », « Aucune photo prise aujourd'hui. »). Un refus est nommé (autorisation absente, ancienne version de l'app) : dis-le tel quel.

## Hors de cet outil
Couper le Wi-Fi n'est pas une action directe : ouvre `device.settings.open {page: wifi}` et laisse Amine le couper. Appeler ou écrire à quelqu'un n'est pas une action de cet outil. Le parcours de paiement et ses SMS ont leur propre propriétaire, jamais celui-ci.
