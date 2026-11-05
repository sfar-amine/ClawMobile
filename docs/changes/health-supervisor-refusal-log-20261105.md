# Gestionnaire de santé : un refus de réparation d'un superviseur est journalisé (05/11/2026)

## Pourquoi
Le 05/11, la surveillance ADB est restée arrêtée après le reboot de 15:48, et `health.log` n'en disait rien. `check_supervisor` ignore en silence le code 75 d'`immune_action` (portail refusé ou indisponible), sauf pour `core_services_watchdog`.

La cause du refus était un dossier immunitaire bloqué. Elle est corrigée côté playbooks (`immune-orphan-effect-20261105`).

## Ce qui change
- Un superviseur absent ou périmé dont la réparation est refusée écrit une seule ligne par épisode : `service=<nom> state=down action=repair_not_admitted reason=immune_gate_refused`.
- L'épisode se termine quand le superviseur est sain, ou quand une réparation est admise. La ligne réapparaît alors au refus suivant.
- La réparation directe de `core_services_watchdog` sans Companion est inchangée.
- Aucun redémarrage n'est ajouté : la décision reste au portail.
