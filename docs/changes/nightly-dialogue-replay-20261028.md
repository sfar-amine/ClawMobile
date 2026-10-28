# Recette nocturne : rejeu des conversations — 28 octobre 2026

Décision d'Amine du 28/10, recommandation 3. La recette de 03:00, qui existe déjà, lance aussi le rejeu des conversations du snapshot playbooks actif (`nightly-dialogue-replay.py`). Les appels enregistrés sur le S24 sont rejoués sur un store privé, sans écriture possible. Elle liste aussi les causes d'échec des dernières 24 h qui n'ont pas de texte nommé.

Effet sur la nuit :
- un rejeu en échec la rend `failed` ;
- une cause sans texte la met en `attention`, avec le même voyant de santé et la même alerte qu'aujourd'hui.

Le même rejeu bloque `activate-ui-playbooks.sh` avant la bascule. Ce changement ne doit être déployé qu'après l'activation d'un snapshot playbooks qui porte `tests/test_dialogue_replay.py`.
