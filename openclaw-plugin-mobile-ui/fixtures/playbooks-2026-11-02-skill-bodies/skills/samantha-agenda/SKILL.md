---
name: samantha-agenda
description: Traiter les demandes personnelles de rendez-vous, calendrier, rappelle-moi et notifications Google Agenda plus WhatsApp avec verification des deux canaux et reprise des incidents.
---
# Agenda + WhatsApp
Uniquement pour une demande autorisée d'Amine. Ne pas exposer son agenda à un autre contact.
Pour une création, une lecture ou une modification simple, appeler d'abord l'outil typé `samantha_agenda` (présent dans tes outils ; sinon `tool_search` avec une seule `query`, jamais de `limit` au niveau d'un lot `queries`) : il résout les champs, montre le récapitulatif et attend la confirmation unique. Ne lire `ui-playbooks/agenda/README.md`, `agenda/playbook.md`, `agenda/ACCEPTANCE.md` et les documents de synchronisation qu'en incident, pour un rappel WhatsApp ou si l'outil typé refuse la demande (S24 28/10 : dix lectures et trois questions avant un simple récapitulatif).
Ne pas attendre Git avant de répondre ; utiliser le checkout local.

## Résoudre la demande
Distinguer événement, notification et tâche à terminer. Ne pas remplacer une tâche par un faux rendez-vous.
Canaux validés : notification native ET WhatsApp, sauf instruction contraire.
Clarifier seulement les champs que l'outil typé déclare manquants (date, début, fin/durée en général) ; calendrier, fuseau et rappel suivent les valeurs par défaut de l'outil.
Aucune heure de soirée ni durée ni calendrier par défaut n'est validé.
Conserver le sens de « 24 h avant » versus « la veille à une heure locale ».

## Exécuter et vérifier — V3 Google direct
Google Agenda est la source autoritative. Utiliser le plus court executor autorisé : connecteur Google Calendar natif lorsqu'il est exposé sur la surface, ou runtime Google direct S24 pour les liens/rappels. Ne jamais revalider Google contre la copie Android sur le chemin nominal.

- Lecture simple : une lecture Google valide est terminale. Aucun check scheduler, Android ou WhatsApp.
- Création sans rappel WhatsApp : résoudre les champs une seule fois, créer, puis faire un seul readback Google ciblé.
- Création avec rappel WhatsApp : après le readback Google, associer l'identité exacte au runtime V3 existant ; ne pas créer un second job V1.
- Modification : relire uniquement pour l'identité exacte/ETag nécessaire, muter, puis un readback Google. Le runtime lié réconcilie le job dérivé ; pas de disable/rebuild conversationnel par défaut.
- À l'échéance : `tick/fire` restent déterministes, sans modèle ; `fire` relit Google avant envoi et ne rejoue jamais une émission incertaine.
- Android CalendarProvider est rollback/compatibilité uniquement. Le vérifier seulement lorsqu'une demande porte explicitement sur la notification Android ou lors d'un rollback.
- Ne vérifier le scheduler que lorsqu'un rappel WhatsApp est demandé ou qu'un incident scheduler est signalé.

Si Google retourne `invalid_grant`/autorisation révoquée, utiliser `python3 tools/reauthorize_agenda_google.py --json`. Cette route ouvre une seule frontière humaine Google, sauvegarde/écrit les credentials privés atomiquement et vérifie `google_calendar_direct` avant succès. Aucun secret ne doit passer dans le chat, les logs ou Git.

## Incident
Appliquer `ui-playbooks/agenda/RECOVERY.md` : reçu canonique, lien tâche-capacité-incident, attente bornée puis vérification ciblée.
Un refus externe n'est ni une panne S24 ni une autorisation de contourner la protection.
Ne jamais confondre signalement, réparation, reprise et résultat utilisateur vérifié.

## Synchronisation V3 des nouveaux liens
Lire `ui-playbooks/agenda/SYNCHRONIZATION.md` et `agenda/SYNC_ACCEPTANCE.md` avant création. Utiliser `agenda.sync_runtime track` avec les identifiants Google et le fuseau résolus, puis relire uniquement l’état du lien/job dérivé nécessaire. Ne pas doubler un lien V3 par un job V1. Google direct est la source nominale ; la copie Android et SyncManager sont des chemins de rollback/diagnostic seulement, sauf demande Android explicite. Les règles calendaires, récurrences et limites de recette restent explicites.
