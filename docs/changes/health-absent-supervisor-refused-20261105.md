# Gestionnaire de santé : un superviseur absent n'attend plus indéfiniment une admission refusée (05/11/2026)

## Pourquoi
Le 05/11 au soir, la nouvelle ligne `repair_not_admitted` a montré deux superviseurs absents, `core_services_watchdog` et `incident_manager`. Ils sont morts aux reboots des 03-04/11.

Leurs dossiers immunitaires avaient épuisé le budget de décisions du modèle et étaient escaladés `human_required` : chaque admission était refusée, indéfiniment. Leurs verrous étaient libres et rien n'empêchait un démarrage, sauf le portail.

Le Companion avait déjà la règle utile (S24 03/11) : un processus absent n'a aucun travail à interrompre, donc une relance espacée reste permise malgré l'escalade humaine.

## Ce qui change
- Un superviseur de base absent dont l'admission est refusée sans interruption depuis `LATCHED_RETRY_S` (15 min par défaut) est démarré directement par le même effet borné :
  - même budget de relances, même temporisation, même verrou singleton ;
  - si l'escalade est `human_required`, le retry espacé du Companion (`latched_dead_retry`) s'applique.
- La ligne de journal est `action=direct_repair reason=absent_supervisor_refused refused_s=<n>`.
- Un refus frais reste respecté : une décision « attendre » de Sol garde son effet pendant 15 min.
- Un superviseur vivant n'est jamais remplacé sans admission.
- Dès que le superviseur est sain, l'épisode de refus est clos. La guérison requalifie l'incident par les chemins existants (`healthy`, puis la revue immunitaire).
