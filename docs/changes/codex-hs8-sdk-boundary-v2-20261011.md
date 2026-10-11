# HS8 — Préparation SDK, version 2

Le propriétaire public de transcription existe dans OpenClaw 2026.9.6 et ses exports sont maintenant confirmés sur le paquet installé du S24. Cette preuve remplace le constat initial limité aux chemins du Companion, où aucun propriétaire STT de mémo n'était raccordé. Elle ne qualifie ni fournisseur, ni transcription d'audio, ni délais et journaux.

Le delta prépare une projection pure des résultats SDK, testée, qui conserve le texte accepté et ne publie aucun détail privé. Elle reste sans appelant produit. Il n'y a aucun import du SDK, lecture de configuration, appel fournisseur, route, upload audio, catalogue activé, nouveau store ou changement au paiement.

Contrat : `docs/work/samantha-runtime/contracts/hs8.md`. Base isolée `5de1c492fe4a8f140c823848ee5bd1d884cd4c02`. Les tests de sortie sont contractuels générés ; seule la présence des exports est une preuve S24 réelle. `npm run build` et `node scripts/test-memo-stt-boundary.cjs` passent (exit 0). La CI conserve toutes ses étapes et ajoute ce test. Retour arrière : retirer uniquement cette préparation sans donnée runtime à restaurer. Qualification et activation restent chez Claude ; merge_eligibility blocked.

## Reprise GitHub — 11/10
Base runtime actuelle intégrée par merge. Build + `test-memo-stt-boundary.cjs` repassés. Les captures #129/#131 n'apportent ni qualification du compte réel fournisseur, ni fixture audio neutre. Aucun appel STT effectué. Le raccordement reste bloqué et aucun producteur ne peut annoncer `inputs.voiceMemo:true` sur cette seule preuve SDK. L'activation devra attester fournisseur et compte autorisés avant le premier appel, sans exposer d'identifiant de compte ni de secret dans Git, avec refus d'un fallback non qualifié. Aucun changement de configuration ou déploiement.

Reprise 42 : décision Gemini → OpenAI reçue ; adaptateur du propriétaire SDK et format M4A préparés sous le garde de qualification existant. Configuration canonique réutilisée, aucun modèle/compte créé. Captures S24 audio/auth/budgets/journaux demandées à Claude ; aucun upload audio ni appel fournisseur activé.

La préparation peut être intégrée sous le garde fermé ; les captures et la recette S24 restent obligatoires avant transcription produit ou activation du micro.


Capture Claude #170 `a75955f8` : les exports publics existent en global, mais ne sont pas résolus depuis Companion ; `tools.media.models=[]`. Résolution existante complétée par la racine npm globale bornée, validation du paquet 2026.9.6 et imports ESM publics, sans installation ni auth maison. Test ajouté à la CI ; npm ci/build et cinq suites ciblées Node20 verts sous verrou EX. Première passe interrompue par mauvais nom pipeline conservée ; passe finale corrigée entièrement verte. Nouvelle suite complète toujours requise. Proposition Google `gemini-3-flash-preview` puis OpenAI `gpt-4o-transcribe` documentée dans le contrat, issue du SDK public et non de la capture. Aucun micro ou chemin produit activé ; Claude/Amine gardent configuration et essais live.
