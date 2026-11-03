# Capture S24 du 02/11/2026 — jobs planifiés et racine de code

- `cron-jobs.json` : les 12 lignes de `~/.openclaw/state/openclaw.sqlite`, table `cron_jobs` (colonnes
  `payload_kind`, `declaration_key`, `enabled` et `job_json`), lues en lecture seule (`mode=ro`) par `claw_exec`.
- Nettoyage : `state`, `delivery`, `failureAlert`, `description` et `payload.toolsAllow` retirés ; l'argv du
  diagnostic SMTP désactivé (hors lot) est remplacé par un marqueur. Aucun secret, jeton, e-mail ni numéro.
- Schéma de la table : `cron-jobs.schema.sql` (copie exacte du `CREATE TABLE`).
- Utilisée par `installer/termux-lite/test-job-code-root.py` : six jobs encore lancés depuis une copie de
  travail (Agenda Sync, Point des tâches, Bilan 17:00, Context Compactor, Context Guardian, curateur mémoire),
  Engineering Maintenance déjà sur l'épingle, Recette nocturne en exception documentée.
