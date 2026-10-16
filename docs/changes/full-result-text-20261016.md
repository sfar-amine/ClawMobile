# Résultats déterministes affichés en entier (16/10/2026)

Demande d'Amine (capture « Résultat à vérifier », équipe ZAIN BAHRAIN Wave 1) : la fiche affichait 5 membres sur 7 puis « - … ». « Quand c'est long il devient tronqué, il ne faut pas avoir de limite. »

## Changement
`installer/termux-lite/model-fast-path.py`, `_generic_display` / `_generic_value` : plus aucune coupe d'affichage.
- Toutes les lignes d'une liste (avant : 5, puis « - … ») et toutes les cellules de chaque ligne (avant : 4).
- Tous les tableaux, toutes leurs lignes et toutes leurs colonnes (avant : 3 tableaux, 8 lignes, 6 colonnes).
- Tous les champs d'un objet (avant : 8 ou 12) et d'un résultat unique (avant : 24).
- Valeurs texte complètes (avant : 160 caractères) et texte total complet (avant : 4 000 caractères).

Inchangé : les clés techniques (`_GENERIC_HIDDEN`, `*_ms`) restent masquées, et `_plain_display` refuse toujours les valeurs sensibles (jetons, URL, numéros, JSON brut). Les volumes restent bornés par les exécuteurs eux-mêmes ; aucun stockage nouveau.

## Tests
`test-model-fast-path-generic-display.py` (déjà inscrit dans `ci.yml`) : nouveau cas `test_long_results_are_never_truncated` (équipe de 7 membres complète, 40 lignes, 4 tableaux de 30×9, 40 champs, commentaire long, texte > 4 000 caractères) ; le cas « congés » vérifie les 7 demandes au lieu de « - … ».

## Capability et architecture
Aucune capability ni route nouvelle ; présentation seulement. L'app (`RunJourneyContract.kt`) retire ses propres coupes dans une PR app séparée.

## Retour arrière
Revenir au commit précédent du fichier ; aucun état runtime.
