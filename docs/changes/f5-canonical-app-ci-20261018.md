# F5 — canonical local CI delegates to the existing Android owner

App delivery has `android-app.yml` rather than the Companion's `ci.yml`. The canonical local CI previously failed before it could verify an app PR. It now verifies the exact GitHub head/base as before, selects the delivery line from that commit, and delegates app verification to its versioned `android/samantha/tools/build-apk-offphone.sh`. Claude confirmed that owner and its receipt contract on [playbooks #189](https://github.com/sfar-amine/samantha-ui-playbooks/pull/189#issuecomment-6248649742).

The delegated build runs in a clean detached worktree, without `SAMANTHA_DEBUG_KEYSTORE` or `--publish`. It must restore tracked sources. The canonical runner checks `build.json` against the requested commit, requires positive test/suite counts and zero failures, errors or skipped tests, checks toolchain version evidence, and recomputes the APK checksum against both receipt and checksum file. APK, checksum and receipt stay beside the caller's log for review. No phone, publication or installation is involved. The final log distinguishes the one delegation step from the JVM test count; it does not claim to replay Android signing/publication Actions steps.

F5 disk preflight now checks temporary and output volumes before creating worktrees: at least 1 GiB free, or 2 GiB for app builds. This conservative floor is not a capacity guarantee. Insufficient space fails with the path, available bytes and required floor; it never deletes caller data. Existing Android artifact folders are refused to prevent stale proof.

`tools/test_localci.py` remains registered in `ci.yml`. Offline disposable Git repositories and a versioned fake Android builder test exact-PR-head enforcement, delegation arguments and key removal, valid retained evidence, nonzero owner exit, checkout restoration, missing owner, malformed/missing/wrong-SHA/checksum/toolchain receipts, nonpositive/boolean test counts, failed/skipped tests, stale artifacts and low disk without cleanup. These are CI contract fixtures, not invented S24 observations; no runtime data is read.

No route, capability, store, registry, router, scheduler or daemon is added. Payment, live voice and inherited runtime environment sanitation are unchanged. Rollback is to revert this commit; the app owner remains independently usable as confirmed by Claude. Full local CI must be cited on this PR's exact head before it is marked ready; Android PRs must additionally cite their own canonical runner log and retained `build.json`.

Le workflow Android est aussi validé avant délégation : une définition vide ou un nouveau
job non couvert fait échouer le contrôle. Le rejeu conserve les XML des tests, y compris
en échec, avant de retirer le checkout jetable (256 fichiers, 1 Mio/fichier, 8 Mio au total,
sans suivre les liens symboliques). La pile d’erreur reste ainsi consultable hors S24.
Tests ciblés finaux du propriétaire CI : 20/20 verts.

## Propagation de F1 et du runtime qualifié

La branche F5 intègre par merge normal le head F1 exact `3cfa1bcbb6a0e3251685f7b27209a37a3c4b1318`, qui contient le runtime `cc4d26c3` et les correctifs Claude #359. Le blob propriétaire `tools/localci.py` reste strictement celui de `db458aefbab6ea25c20f801c67765d44c3d787de` ; aucun deuxième runner n’est créé. Le checkout détaché utilisé pour les qualifications courantes reste gelé et distinct de ce worktree de développement.

Union des workflows confirmée par comparaison des commandes des deux parents : aucune étape supprimée. Les deux tests hérités `test-owner-retention.py` et `test-claw-trace.py` restent inscrits. Ciblés hors téléphone :20/20 contrats du runner (3,292s),11/11 fondations runtime (0,157s),12/12 rétention propriétaire (0,576s) et6/6 trace (0,485s), sans exécution d’une suite complète. Les repositories et builders Android utilisés par les tests du runner sont synthétiques et locaux ; ces sorties ne constituent ni une construction app physique ni une CI complète de cette PR.

Le nouveau head impose une qualification canonique PR323 avant de repasser prêt à relire. Les anciens reçus, même verts, restent historiques et ne qualifient pas ce nouveau commit. Paiement, voix directe et décision D ne sont pas modifiés par F5 ; les changements hérités de Claude sont conservés. Retour arrière : retirer le lot F5 avec ses propriétaires existants, sans annuler les corrections runtime héritées de #320/#359.


## Propagation du head F1 final — 18 octobre

Merge local normal de F1 `064a66e95649bf6362232bb69201edf57d24e321`, incluant les diagnostics propriétaire `e873` et les correctifs runtime/voix #359 hérités. Aucun conflit ; l’union des lignes de commandes `run:` des deux parents est vérifiée, dont la nouvelle étape de diagnostics. Le blob `tools/localci.py` reste exactement `bca06e29ce6eb7e92718427eb88082539d61ac72` : aucune modification du runner source et aucun accès au runner isolé de qualification.

Ciblés hors téléphone :20/20 contrats unitaires du runner,11/11 fondations runtime,12/12 diagnostics propriétaire, suppression de run et compilation TypeScript verts. Les sorties LOCALCI des tests unitaires sont des fixtures synthétiques courtes avec builder simulé, pas un lancement canonique complet de cette PR. Le checkout n’avait pas ses dépendances TypeScript : installation du lockfile existant avec scripts désactivés, puis compilation réussie ; aucun garde ou source ajusté pour obtenir du vert.

Le head source est gelé pour une nouvelle CI complète exacte avec le numéro323 quand son créneau sera accordé. Toutes les preuves des anciens heads restent historiques ; cette propagation n’est pas une qualification complète ni un déploiement. PR conservée en brouillon.
