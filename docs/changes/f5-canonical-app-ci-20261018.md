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
