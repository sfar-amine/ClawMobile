# Outils typés : l'origine du tour est lue dans le registre du Companion

**Constat (S24, 07/11 17:54, après core#563).** « mon solde orange » partagé depuis l'app : nouveau refus du garde Orange (`orange_cellular_required_wifi_kept`, Wi-Fi jamais coupé). La ligne du tour dans le registre du Companion était correcte (pas de `voiceDelegation`). Pourtant, la décision enregistrée par le dialogue pour ce même tour portait la surface `claw_live`. La lecture HTTP du statut (limite 1,5 s) était retombée sur la restriction voix.

**Mesure.** Une sonde a lu `GET /v1/runs/<id>` toutes les 200 ms pendant un tour écrit anodin de 47 s. Six réponses rapides, puis aucune réponse en 3 s pendant environ 40 s. Sur un tour de 7 s, aucun blocage : le phénomène est intermittent.

**Correctif.** L'outil typé lit la ligne du tour directement dans `clawmobile-companion/runs.json`, sans passer par le serveur HTTP du Companion :
- la ligne est écrite avant l'envoi du tour ;
- le fichier est remplacé de façon atomique (fichier temporaire puis renommage) ;
- lecture et analyse : 12 à 17 ms pour 1 Mo sur le S24.

La règle ne change pas : un tour écrit reçoit `samantha_android`. Samantha Voix, un tour inconnu ou un registre illisible gardent `claw_live`. C'est une restriction, jamais une admission.

**Preuve.** `scripts/test-typed-app-surface.cjs` sur `fixtures/s24-2026-11-07-orange-app-surface/registry-and-busy-companion.json` (ligne réelle, décision réelle, sonde réelle). Avec l'ancienne lecture HTTP, le test échoue sur le cas « Companion muet ».

**Hors champ.** La cause du silence du Companion pendant ~40 s reste à traiter à part.
