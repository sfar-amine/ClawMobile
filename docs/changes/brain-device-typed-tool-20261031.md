# Cerveau : outil typé téléphone visible directement — 31 octobre 2026

Trace S24 du 31/10 : aucun outil typé ne touchait le téléphone ; le cerveau passait par le shell (35 s pour allumer la torche). La PR playbooks jumelle (sfar-amine/samantha-ui-playbooks#369) ajoute le skill typé `device-assistance`, projeté en `samantha_device_assistance` : torche, Ne pas déranger, minuteur, alarme, page des réglages, état du téléphone, prochaine alarme, photos du jour, derniers SMS.

Changements :
- `samantha_device_assistance` rejoint `DIRECT_TYPED_TOOLS` (`catalogMode: "direct-only"`), comme les factures, Orange, l'agenda et Pulse.
- La consigne commune des outils typés ne dit plus que toute écriture exige un récapitulatif : seules les actions marquées « récapitulatif puis confirmation » l'exigent ; les autres s'exécutent directement. Décision d'Amine du 31/10 : torche, Ne pas déranger, minuteur, alarme et page des réglages sans récapitulatif ; la liste fermée vit côté playbooks (`confirmation_policy.py`).
- Plafond de la surface directe du prompt porté de 30 000 à 32 000 caractères (mesuré 31 231 avec l'outil téléphone).

Fixture : `fixtures/playbooks-2026-10-31-device-typed-tool/` est une projection source (`project_tools` sur le commit playbooks indiqué), pas une capture S24 ; la capture du catalogue compilé après activation la remplacera.

Tests : `scripts/test-typed-device-direct.cjs` (nouveau, inscrit en CI) ; `test-typed-tools-direct-visible.cjs` exclut explicitement l'outil téléphone, absent de la capture S24 du 25/10.

Retour arrière : revert, puis `companion-deploy.sh` du commit précédent. Déployer après l'épinglage des playbooks #369.
