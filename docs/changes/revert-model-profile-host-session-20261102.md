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

## Limite
#126 reste ouvert. #510 et #516 cassent tous deux l'admission typée ; la cause exacte n'est pas établie.

## Retour arrière
Ré-appliquer #516 seulement avec une preuve que le hook et les outils typés partagent la même instance de module.
