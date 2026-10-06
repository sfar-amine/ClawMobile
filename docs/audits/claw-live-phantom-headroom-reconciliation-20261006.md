# Claw Live — réconciliation du headroom Android — 2026-10-06

## Incident

Le symptôme propriétaire est revenu : après avoir quitté la page/Termux puis être revenu, la session `claw-live` pouvait avoir disparu et Termux demandait Entrée sur un processus terminé.

La correction logicielle du 3 octobre est toujours installée : le mode sémantique de `claw-live` suit les fichiers dans le processus Python et ne recrée pas les anciens `tail -F` persistants. Le SHA-256 du runtime installé correspond à la source courante.

## Preuve et cause racine

Le 6 octobre, `DeviceConfig activity_manager/max_phantom_processes` était revenu à `null`, soit une valeur effective Android de 32, alors que l'invariant S24 documenté depuis le 3 octobre est 128.

Le téléphone n'avait pas redémarré depuis plus de sept jours. Le buffer ActivityManager contient plusieurs kills du jour avec le motif exact `Trimming phantom processes`, touchant notamment des processus Termux `python3`, `bash`, `adb` et `sshd`.

Aucune commande de rollback ou de suppression de cette clé n'a été retrouvée dans les sources Claw, l'historique shell ou l'audit local consulté. L'acteur exact ayant fait disparaître l'override n'est donc pas établi. La cause exploitable de la récidive est l'absence de réconciliation d'un invariant runtime qui n'avait été appliqué qu'une seule fois.

## Correction

Le live a d'abord été remis à `128` et la valeur effective a été relue.

Le correctif durable étend uniquement `samantha-health-manager.sh`, propriétaire de santé déjà actif :
- vérification au plus une fois par minute, après disponibilité ADB canonique ;
- lecture de la valeur effective ActivityManager ;
- aucune écriture quand la valeur est déjà au moins 128 ;
- si elle est inférieure, restauration de `activity_manager/max_phantom_processes=128` ;
- relecture de la valeur effective avant de déclarer la récupération ;
- en cas d'échec, réutilisation du backoff et du chemin incident existants.

Aucun daemon, scheduler, store, routeur ou registre parallèle n'est créé. `claw-live.py`, RDC et les autres superviseurs ne sont pas modifiés.

## Parité MCP owner

La correction ne change ni capability, ni route, ni contrat d'exécution exposé. Les six primitives `claw_context`, `claw_resolve`, `claw_execute`, `claw_exec`, `claw_status` et `claw_artifact_read` sont toutes évaluées `no impact`. La parité de palette `chatgpt/owner` ↔ `external_mcp/owner` passe sur le test canonique. Aucun schéma, adapter ou runtime MCP ne doit être modifié pour ce correctif.

## Régression

Le nouveau test déterministe couvre :
1. état sain 128 sans mutation ;
2. dérive 32 → restauration 128 et vérification ;
3. échec de restauration → état dégradé et backoff existant.

Les suites existantes Claw Live, Tier-0, RDC, Health, incidents, supervision et contrat Slack sont rejouées avant activation.

## Activation et recette live

Clôture vérifiée le 6 octobre 2026 :
- source publiée sur la branche runtime privée et intégrée dans la release immutable Tier-0 `20261006-clawlive-headroom-051c0c2` ;
- release `current` et `last-known-good`, soak `stable`, `0` bad sample ;
- SHA du `samantha-health-manager.sh` actif identique au correctif publié ;
- dérive contrôlée `128 → 64` détectée par le Health Manager, puis restauration et vérification automatique à `128` (`state=drift` puis `state=recovered`) ;
- recette réelle aller-retour : Termux/claw-live mis au premier plan, Samantha ouverte pendant 120 s, puis retour Termux ; le PID `claw-live` est resté `19617` avant/après ;
- aucune occurrence de kill correspondant `Trimming phantom processes` sur ce PID pendant la fenêtre ;
- valeur effective finale `max_phantom_processes=128` ;
- UI de retour sans `Process completed`, `Press Enter` ni demande `Entrée`.

Le symptôme propriétaire est donc reproduit par sa cause d'infrastructure (dérive du headroom) et la correction durable est activée et recettée.

## Retour arrière

Promouvoir la précédente release Tier-0 vérifiée et revert du commit isolé. Pour revenir volontairement au comportement OEM Android, supprimer l'override DeviceConfig ; ce rollback réintroduit cependant le risque déjà prouvé de trimming à 32 et ne doit pas être utilisé comme état normal S24.
