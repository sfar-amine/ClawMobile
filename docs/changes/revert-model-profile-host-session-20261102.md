# Revert de #516 et recette durcie — 2026-11-02

## Constat
Déploiement 20e36415 (#516) le 02/11 à 09:44 UTC : `write_recap` en échec, retour arrière automatique vers 0c5a9b46.

Transcript de recette `agent:main:recette-deploy:20261102t084441z` (résultats d'outils seulement) :
- `samantha_agenda` `agenda.event.read` → `{"state":"unverified","reason":"typed_host_admission_required"}`
- `samantha_agenda` `agenda.event.create` → même refus ; aucun rendez-vous créé.

`owner_read` avait été jugé « passé » : la phrase générique « Je n'ai pas de résultat vérifié pour cette action » ne correspond à aucun motif de réponse cassée.

## Changement
- Revert du code de #516 ; la note et les fixtures de #516 restent.
- `deploy-parcours.py` : un résultat d'outil typé `typed_host_admission_required` dans le tour fait échouer le parcours (`typed_admission_refused`), quelle que soit la phrase.
- `companion-deploy.sh` `rollback()` : une fois l'identité du checkout prouvée (HEAD = précédent, dist = sauvegarde), `runtime-sync.sh <précédent>` tourne toujours, même si la santé du Companion n'est pas prête ; nouveau contrôle `runtime_restored` dans `rollback_acceptance`.

## Incident du 02/11
La santé du Companion n'était pas prête à temps après le rollback : `runtime-sync` (fin de chaîne `&&`) n'a pas tourné. L'extension de la Gateway est restée en #516 (et la Gateway avec), outils typés refusés en production jusqu'au `runtime-sync.sh 0c5a9b46` manuel de 10:25 (`ok:true`, plugin synced, gateway restarted).

## Cause racine des refus (#510, #516, et 0c5a9b46 après 10:24)
OpenClaw 2026.10.9 charge `openclaw-plugin-mobile-ui` plusieurs fois dans la Gateway : la capture du 02/11 10:24 en contient trois copies (10:25:19, 10:25:56, 10:28:48 ; `fixtures/s24-2026-11-02-plugin-copies/capture-builds.json`). La preuve d'admission typée était une `Map` propre au module : le hook `before_tool_call` d'une copie y écrivait, l'outil d'une autre copie ne la voyait pas → `typed_host_admission_required`. Selon l'ordre de chargement, cela passait (00:20, 5/5) ou cassait (après 10:24, même plugin).

Correctif : registre de preuves et sceau communs au processus (`globalThis`, `Symbol.for('samantha.typed-invocations.v1')`, défini une fois, non remplaçable, non énumérable). Test `test-typed-admission-shared-instances.cjs` : deux copies de `dist`, hook dans l'une, exécution dans l'autre.

#126 reste ouvert ; #516 pourra être retentée une fois ce correctif en production.

## Retour arrière
Ré-appliquer #516 seulement avec une preuve que le hook et les outils typés partagent la même instance de module.
