# Outil typé `samantha_device_assistance` — projection source du 31/10

`device-assistance-tool.json` est l'entrée `samantha_device_assistance` produite par `project_tools` (samantha-ui-playbooks, commit indiqué dans le fichier : réglages classiques de la PR #372 inclus), sans effet métier. Ce n'est pas une capture S24 : la capture du catalogue compilé après activation des playbooks remplacera cette projection. Les autres outils restent ceux de la capture S24 `s24-2026-10-25-typed-tools`.

Elle sert à vérifier, avec les fonctions publiques du plugin, que l'outil est visible directement (`catalogMode: "direct-only"`), que les treize réglages directs (torche, Ne pas déranger, minuteur, alarme, page des réglages, volume, luminosité, sonnerie, économie d'énergie, Bluetooth, réactivation du Wi-Fi, ouverture d'appli, capture d'écran) ne sont pas marqués « récapitulatif puis confirmation » et qu'un appel part en une seule invocation du propriétaire typé.
