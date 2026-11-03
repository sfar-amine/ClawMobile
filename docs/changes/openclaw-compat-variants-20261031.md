# Correctifs OpenClaw : un jeu par version installée — 31 octobre 2026

Préparation de la montée vers OpenClaw 2026.10.9. Chaque correctif de compatibilité était épinglé sur les fichiers exacts de la 2026.9.6 et refusait toute autre version ; le refus de `model-flow-selection` empêche même `gateway-start.sh` de démarrer la Gateway. Un commit qui remplacerait simplement les manifestes serait donc refusé tant que la 2026.9.6 est installée.

Changement : le propriétaire existant (`openclaw-compat/whatsapp-network-recovery.py`) choisit le jeu de fichiers de la version OpenClaw installée. `package_version` + `files` gardent le jeu 2026.9.6 tel quel ; une table facultative `packages` ajoute d'autres versions. Un même commit possède ainsi chaque correctif avant, pendant et après la montée, et au retour arrière. Une version inconnue est refusée avant toute écriture, comme avant.

Variantes 2026.10.9 ajoutées :
- `memory-retrieval-warm` : même option sur le pool de rappel (le défaut de 60 s n'a pas changé en 2026.10.9) ;
- `native-turn-provenance` : deux fichiers tels quels, une ancre réécrite dans `get-reply` (l'objet `transport` y est toujours construit ; un tour qui ne porte que l'identifiant de run enregistre désormais un `transport`) ;
- `agent-exec-auth-scope` : tel quel ;
- `model-flow-selection` : la sélection de modèle vit désormais dans `embedded-agent`, qui exporte `applyHookModelProfile` et `resolveHookModelSelection` pour `run-entry` et `compact` ; les six déclarations de types sont réunies dans `config-contracts-*.d.ts`.

Preuves : modules capturés du paquet npm (`fixtures/openclaw-2026.10.9-compat/`), identiques au candidat installé à part sur le S24. Le jeu `model-flow-selection` y a été reconstruit avec la même empreinte, et ses cinq modules corrigés s'y importent avec leurs vraies dépendances. Test `installer/termux-lite/test-openclaw-compat-variants.py`, inscrit en CI.

Restent hors de ce lot : la variante 2026.10.9 de `whatsapp-network-recovery` (version du paquet WhatsApp à épingler), le correctif Android des copies de fichiers et de `/proc/self/ns/pid` (repris de openclaw-android), puis la répétition de la montée sur le S24.

Aucun effet sur la 2026.9.6 installée. Retour arrière : revert.
