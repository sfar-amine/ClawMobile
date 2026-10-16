# M3 — télémétrie machine hors de la mémoire partagée — 12/10/2026

## Constat (S24, lecture seule, 11/10)
`memory.db` contient 2 025 événements, dont 862 de télémétrie machine, tous actifs :
- 401 `SITUATION_EVENT_V1` (work/checkpoint) ;
- 345 `LEARNING_GATE_V1` (334 openclaw + 11 chat) ;
- 48 « Companion déployé … recette automatique acceptée » (work/completed_action) ;
- 68 `IMPROVEMENT_CANDIDATE_V1` (79 propositions de pont, toutes « bridged »).

La vue les excluait déjà de l'activité récente, mais ils restaient écrits, comptés dans « Actifs », cherchés et repris dans le digest du curateur.

## Changement par producteur
- **`companion-deploy.sh`** : plus d'écriture dans `memory.db`. Le reçu `~/.openclaw/deploys/companion-*.json` (servi par `deploymentReceipts.ts`) fait foi. La copie déployée `~/.openclaw/tools/companion-deploy.sh` est une ancienne version (`0bc75d21`) de ce fichier.
- **`learning-gate-close.sh`** : `LEARNING_GATE_V1` (clôture sans apprentissage réutilisable) reste dans le reçu, le registre et `DEVELOPMENT_JOURNAL.md` du gate. Seul `IMPROVEMENT_CANDIDATE_V1` entre encore en mémoire : le curateur le transforme en `dream_proposals`, que lit le pont improvement. `learning-gate.py` est inchangé.
- **Situations** (playbooks, PR séparée `feat/m3-situations-telemetry-20261012`) : plus de `SITUATION_EVENT_V1`.

## Lecteurs vérifiés
Recherche dans les deux dépôts et sur le S24 :
- **Vue (`context_memory`)** : utilisait déjà un filtre. Désormais, les reçus de retrait sont exclus des comptes, de la recherche par défaut et de l'activité récente.
- **Curateur (`context-dream`)** : n'exploite que `IMPROVEMENT_CANDIDATE_V1`. Il exclut désormais la télémétrie de `memory_digest`.
- **Pont improvement** : lit `dream_proposals`, il n'est pas touché.
- **`claw_daily_v2`** : ignorait déjà `LEARNING_GATE_V1` dans les learnings affichés. Les comptes du rapport deviennent justes.
- **`reconcile_context`** : ne lit que `SITUATION_SIGNAL_V1:`.
- `health-verdict`, `claw_context`, `control_snapshot` et `request_context` ne lisent aucun de ces préfixes.

## Refus défensif
`REFUSED_TELEMETRY` (`context_memory.py`) couvre `SITUATION_EVENT_V1:`, `LEARNING_GATE_V<n>:` et le format exact du message de déploiement. Ces lignes sont refusées :
- par `context-event.sh` (code 66, avant tout fichier en attente) ;
- par `ingest_file` (`machine_telemetry_refused`).

Le rejeu d'un fichier déjà accepté dans `processed/` reste possible (reconstruction de la base).

`IMPROVEMENT_CANDIDATE_V1` n'est pas refusé, car il a un producteur et un consommateur légitimes.

## Remplacement des événements existants (préparé, non exécuté)
`installer/termux-lite/context-retire-telemetry.py` :
- `--dry-run` (défaut) : compte, sans aucune écriture ;
- `--apply` :
  - sauvegarde de `memory.db` par l'API backup de SQLite, avec contrôle d'intégrité, dans `~/.openclaw/context-backup/m3-telemetry/` ;
  - écriture d'un manifeste ;
  - un checkpoint `MEMORY_RETIRE_V1` par cible, ingéré par `ingest_file(require_active=…)`, comme `control-forget` ;
  - aucun DELETE ni UPDATE ;
  - une compaction à la fin ;
- `--restore <manifeste>` : restaure la sauvegarde seulement si aucune autre écriture n'a eu lieu depuis, puis retire les reçus de `processed/`.

Seuls les `IMPROVEMENT_CANDIDATE_V1` déjà consommés (sous le curseur du curateur et pontés) sont concernés.

`--dry-run` attendu sur le S24 au 11/10 : `{"situation_event":401,"learning_gate":345,"companion_deploy":48,"improvement_candidate":68,"total":862}`.

## Tests
`test-context-scale.py` (dans la CI), classe `TelemetryOutOfMemoryTests`, 7 cas :
- refus à l'entrée ;
- `context-event.sh` ;
- producteurs ;
- formes réelles du S24 ;
- dry-run puis apply ;
- restauration ;
- digest du curateur.

Les 7 cas échouent sur l'ancien code. `test-learning-gate.py` est mis à jour, mais il ne s'exécute que sous Termux (shebangs) et n'est pas dans la CI.

Fixture : `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11-m3-telemetry/` (formes réelles, valeurs remplacées).

## Ordre de déploiement
1. Épingler les playbooks M3, sinon l'ancien write-back des situations est refusé à chaque passage de maintenance.
2. Déployer ce Companion.
3. Lancer `--dry-run`, puis `--apply`.
