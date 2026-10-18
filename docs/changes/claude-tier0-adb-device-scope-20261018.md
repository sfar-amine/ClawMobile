# Santé : l'ADB perdu ne déclenche plus de retour arrière Tier0

## Constat (S24, 18/10, lecture seule)
- 15:51:43 : `network_safety state=warning reason=wifi_disabled_without_lease` (Wi-Fi coupé hors garde).
- 16:24 : après le déploiement 612b06cd, le gestionnaire de santé tente `adb fast_reconnect` ; le Débogage sans fil ne peut pas revenir sans Wi-Fi.
- 16:27 : budget adb 3/3 épuisé → `tier0-control.py rollback --reason health_restart_budget_exhausted:adb` (tier0/state.json : `rolled_back_from 20261018T161407-d3beb769`). Le rollback redémarre companion et gateway.
- 16:28:27 : « mon solde Orange » à la voix tombe pendant ce redémarrage (`gateway is unreachable`), réponse « le service ne répond pas » à l'étape « Choix de l'exécuteur ».
- 16:29:59 : `adb state=human_required` ; le rollback n'a rien réparé.

## Cause
`restart_gate` traitait tous les services de la même façon : budget épuisé → retour arrière Tier0. Or l'ADB est un service de l'appareil (`scope adb` = `boot-<boot_id>`, déjà distingué pour les incidents) : aucune release ne le répare.

## Correctif
Dans `restart_gate`, un service dont le scope n'est pas `runtime` ne déclenche plus de rollback : `action=tier0_rollback_skipped reason=device_scope`, puis `human_escalate` direct avec un message propre (« un retour arrière Tier0 ne peut pas le réparer », Wi-Fi puis Débogage sans fil). Les services de runtime gardent budget → rollback → human_required.

## Tests
`test-health-restart-escalation.py` : nouveau cas `test_adb_budget_never_rolls_tier0_back` (ancien code : échec, rollback appelé).

## Retour arrière
Revert du commit.
