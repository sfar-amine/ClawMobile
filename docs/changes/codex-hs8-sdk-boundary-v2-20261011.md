# HS8 — Préparation SDK, version 2

Le propriétaire public de transcription existe dans OpenClaw 2026.9.6 et ses exports sont maintenant confirmés sur le paquet installé du S24. Cette preuve remplace le constat initial limité aux chemins du Companion, où aucun propriétaire STT de mémo n'était raccordé. Elle ne qualifie ni fournisseur, ni transcription d'audio, ni délais et journaux.

Le delta prépare une projection pure des résultats SDK, testée, qui conserve le texte accepté et ne publie aucun détail privé. Elle reste sans appelant produit. Il n'y a aucun import du SDK, lecture de configuration, appel fournisseur, route, upload audio, catalogue activé, nouveau store ou changement au paiement.

Contrat : `docs/work/samantha-runtime/contracts/hs8.md`. Base isolée `5de1c492fe4a8f140c823848ee5bd1d884cd4c02`. Les tests de sortie sont contractuels générés ; seule la présence des exports est une preuve S24 réelle. `npm run build` et `node scripts/test-memo-stt-boundary.cjs` passent (exit 0). La CI conserve toutes ses étapes et ajoute ce test. Retour arrière : retirer uniquement cette préparation sans donnée runtime à restaurer. Qualification et activation restent chez Claude ; merge_eligibility blocked.

## Reprise GitHub — 11/10
Base runtime actuelle intégrée par merge. Build + `test-memo-stt-boundary.cjs` repassés. Les captures #129/#131 n'apportent ni qualification du compte réel fournisseur, ni fixture audio neutre. Aucun appel STT effectué. Le raccordement reste bloqué et aucun producteur ne peut annoncer `inputs.voiceMemo:true` sur cette seule preuve SDK. L'activation devra attester fournisseur et compte autorisés avant le premier appel, sans exposer d'identifiant de compte ni de secret dans Git, avec refus d'un fallback non qualifié. Aucun changement de configuration ou déploiement.
