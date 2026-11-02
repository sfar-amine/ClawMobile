# #126 : les hooks de profil de modèle passent par la session de l'hôte (02/11/2026)

## Constat
Après chaque redémarrage de la Gateway, le premier tour d'agent prend 72 à 90 s :
- profil S24 du 01/11 après #498 : 72,4 s sous `plugin-generation-artifact` ;
- recette du 02/11 à 00:20 : `owner_read` en 90,6 s.

Sur ces 72,4 s, 41,9 s servent à recopier dans la capture du plugin le graphe du SDK « session store » : 21 045 fichiers et 190 Mo. Ce SDK est importé par URL de fichier par le hook de profil de modèle (`fixtures/s24-2026-11-01-plugin-capture/capture-after-498.json`).

La tentative #510 allait plus loin :
- elle partageait les instances de l'hôte pour quatre autres chargeurs ;
- elle n'installait plus que le strict nécessaire dans l'extension.

Avec elle, tout appel d'outil typé était refusé (`typed_host_admission_required`). Elle a été retirée par #515.

## Correctif
Dans la Gateway, `conversationModelProfileHooks` utilise l'API que l'hôte fournit déjà au plugin :
- `api.runtime.agent.session` : `getSessionEntry`, `listSessionEntries`, `patchSessionEntry` ;
- `api.runtime.config.current()`.

Ce sont les mêmes fonctions, avec les mêmes paramètres que la surface du SDK installé (relevé 2026.10.9 dans `host-session-api-2026.10.9.json`).

Aucun module de l'hôte n'est importé : OpenClaw ne recopie donc rien dans la capture, et aucune seconde instance de module n'existe.

La version du contrat de profil est lue comme du texte dans son chunk haché (`readChunkConstExport`, repris de #510), sans import. Le chargeur du Companion profite aussi de cette lecture.

Le Companion n'a pas d'`api`. Comme un hôte qui n'exposerait pas l'une de ces fonctions, il garde le chargeur existant : le comportement est inchangé.

Ne sont pas repris de #510 :
- les autres chargeurs (tour propriétaire, Gateway officielle, media-store, mémo) ;
- l'extension réduite.

## Tests
- `scripts/test-model-profile-host-session.cjs` (nouveau, inscrit dans `ci.yml`) :
  - repli sur le chargeur ;
  - délégation exacte ;
  - chargeur jamais appelé quand l'API de l'hôte existe ;
  - lecture du contrat comme texte.
- `test-conversation-model-profile.cjs` et `test-model-flows.cjs` : inchangés et verts.

## Validation en prod
- La recette du déploiement doit passer 5/5, outils typés compris (`owner_read`, `write_recap`). Si elle échoue, le retour arrière automatique s'applique.
- Mesure attendue : premier tour après redémarrage nettement sous les 90,6 s, la recopie de 41,9 s étant supprimée.

## Retour arrière
Revenir sur ce commit, puis lancer `companion-deploy.sh` vers le commit précédent.
