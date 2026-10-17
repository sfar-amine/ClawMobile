# HS8 — qualification S24 du mémo vocal (17/10/2026)

`MEMO_STT_QUALIFICATION` n'est plus une constante fermée : `memoSttBoundary.qualifyMemoStt` le calcule depuis le reçu S24 du 17/10 (`fixtures/s24-2026-10-17/hs8-qualification/`). Le reçu prouve le propriétaire canonique installé (SDK 2026.9.6, Gemini `gemini-3.5-flash-lite`, profil gratuit verrouillé, prompt identique par SHA256), un conteneur `mp42` comme le recorder Android, une transcription exacte, aucune tentative d'un autre fournisseur, aucune écriture runtime et aucune trace du texte dans les journaux. Modèle, profil, version SDK et prompt sont désormais des constantes de `memoSttBoundary` lues par `memoSttOwner` : les changer referme l'entrée jusqu'à un nouveau reçu.

Effet après déploiement : `/v1/catalog` annonce `inputs.voiceMemo {available:true, availability:"available"}`, l'upload `audio/mp4` est admis (bornes existantes : 10 Mio, 120 s, piste `soun`), et POST `/v1/runs` accepte le mémo avec admission P1 fraîche. Aucune route nouvelle, aucun store, aucun scheduler.

Ligne d'acceptation : `companion-acceptance.py` vérifie la forme de `inputs.voiceMemo` sur `/catalog` (malformé = échec ; fermé = avertissement `voice_memo_unavailable`, sans retour arrière).

Tests (CI) : `test-memo-stt-boundary.cjs` (reçu = fixture, SHA des audios, 29 reçus falsifiés refusés), `test-memo-stt-owner.cjs`, `test-memo-sdk-resolution.cjs`, `test-catalog.cjs`, `test-memo-intent-pipeline.cjs`, `test-memo-deferred-retry.cjs`, `test-memo-p1-http.cjs`, `test-companion-acceptance-memo.py`.

Retour arrière : revenir sur ce commit (ou retirer un échantillon du reçu) referme catalogue, upload et soumission ; les runs mémo en cours finissent par le chemin d'échec existant.
