# Slack purge timeout hardening — 2026-09-30

## Constat
Le job `samantha:slack-control-purge` est horaire mais utilisait un timeout de 90 s. Les runs réels ont montré plusieurs clusters de timeouts suivis des retries natifs OpenClaw. Le cluster le plus récent a démarré à 18:56:47 UTC, a retenté à 18:58:47, puis a réussi à 19:01:17.

La dernière réussite observée a duré 75,312 s et a supprimé 38 parents et 47 réponses après 94 messages scannés. Le budget de 90 s était trop proche de la charge réelle et transformait une housekeeping lente en séquences de retries rapprochés.

## Correction
- Timeout scheduler : 90 s → 240 s.
- No-output timeout : 240 s.
- Cadence : inchangée à 1 h.
- TTL et règles de sélection/suppression : inchangés.
- Le setup devient convergent : un job existant est édité au lieu d'être laissé avec une ancienne configuration.
- Aucun run manuel de purge n'est déclenché par ce changement.

## Validation
- `bash -n claw-slack-purge-setup.sh` : PASS.
- `python3 -m unittest -v test-claw-slack-purge-setup.py` : 3/3 PASS.
- `node test-claw-slack-purge.mjs` : PASS.
- Live : une seule déclaration `samantha:slack-control-purge`, active, timeout=240 s, noOutputTimeout=240 s, prochaine échéance conservée.

## Retour arrière
`openclaw cron edit <id> --timeout-seconds 90 --no-output-timeout-seconds 90`, puis revert du commit source. Aucun état métier ou message Slack n'est créé par le changement de timeout.
