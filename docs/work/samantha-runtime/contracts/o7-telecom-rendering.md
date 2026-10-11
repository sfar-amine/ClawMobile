# O7 — Rendu télécom lisible et provenance bornée

Le rendu existant du fast path ne sérialise plus un résultat structuré dans le
texte de la réponse. Une carte télécom est une ligne : libellé, valeur exacte,
unité, puis validité restante si `days_remaining` est un entier fourni par le
propriétaire. Les cartes restent distinctes : aucune somme, conversion ou
échéance inventée. La projection lit `data.cards` (ou `cards`) du propriétaire
Maxit existant ; ses champs `title`/`label`, `value`, `unit`, `days_remaining`
sont confirmés dans le code canonique `telecom/maxit_direct.py` et ses tests.

Le rendu prend au plus 32 cartes, des libellés de 80 caractères et des unités
fermées. Une valeur non numérique, un champ manquant ou inattendu n'est pas
imprimé ; la carte est alors comptée sur une ligne finale (« N autre(s) carte(s)
non affichable(s) en texte. »), jamais omise en silence. La validité est affichée
jusqu'à 36 500 jours (la capture réelle porte 4 100 jours pour « Compte de recharge »). Les autres objets/listes ont un repli générique lisible ; une chaîne
qui commence par `{` ou `[` n'est pas affichée comme réponse. Les lectures
composées sont bornées à 32 lignes, quatre niveaux, 128 nœuds et 8 000 caractères. Aucun compte, adresse,
URL, contexte de connexion ni JSON brut n'est repris à partir de ces objets.
Le texte libre réutilise le filtre `SENSITIVE` du propriétaire canonique
`context_import.py` (JWT, OTP, tokens…), avant troncature ; les montants
structurés des cartes ne passent pas dans son heuristique de chiffres.
Le cas nominal est la capture S24 réelle du 10/10 à 09:41 ; les autres cartes des tests sont des mutations négatives explicites.

## Provenance

Le reçu canonique porte uniquement `{capability, route, network_path?}`.
La route vient en priorité de `execution.actual_route` (A8), et non de la
route planifiée. Si ce champ est absent (ancien reçu), la route rapportée par le
propriétaire dans son résultat (`result.route_id`) est retenue : sur la capture
du 10/10 à 09:41, le plan était `orange.summary.maxit.v1` et le propriétaire a
exécuté `orange.usage.maxit.v1`. À défaut des deux, le repli est `selected.route`,
provenance seulement planifiée. Un `actual_route` présent mais invalide ne retombe
pas sur le plan et ne produit aucune provenance.
Les deux identifiants sont ASCII, au plus 160 caractères chacun, sans URL ou
adresse. `network_path` vaut exclusivement `wifi_off` ou
`cellular_bind_wifi_on`, lorsqu'il est fourni par l'exécution ou le payload
O1. Aucun champ `network_guard` complet, bail, SSID, réglage ou payload brut
n'est conservé dans la provenance.

`intent.ts` transmet cette projection au propriétaire `settleSubmittedRun`.
Le registre `runs.json` existant la conserve et la relit avec la même liste
fermée. Le statut la projette ; les cartes et valeurs brutes restent absentes
de ce champ. Aucun nouveau store. La rétention existante reste 500 runs et
8 Mio ; la projection ajoute moins de 400 octets par run. Le test initialise
10 000 runs et vérifie la rétention, la relecture ainsi que la préservation
des sections paiements et confirmations. Aucun parcours déterministe de
paiement ni état voix/O9 n'est modifié.

## Qualification et budget

Preuve : `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/o7-o8-orange-20261010-0941.json`
(capture en lecture seule du 11/10, runtime `5de1c49`, nettoyage décrit dans le
`README.md` du dossier : valeurs remplacées à format identique, titres, unités,
validités, `kind` et `section` réels). Les tests vérifient les 8 lignes exactes dans
l'ordre de la capture, l'absence de somme par unité, l'absence de champ brut et la
provenance `{telecom.orange.consultation, orange.usage.maxit.v1}`, sans `network_path`
(la capture précède O1). La fixture historique (playbooks `3862baa`) reste le contrôle
du repli générique lisible.

Les tests sont inscrits dans la CI. Aucune route HTTP n'est ajoutée, donc aucune
ligne dans `companion-acceptance.py`. Le budget du fast path n'est pas changé par O7 ;
O6 porte la borne du wrapper réseau. La projection est locale, bornée et ne fait aucun
appel Gateway.

Recette live (Claude, après activation) : une consultation « Mon solde Orange » par
l'app, via l'entrée canonique ; la réponse affichée a une ligne par carte et le run
`runs.json` porte `provenance` avec `network_path` issu du reçu O1.

Retour arrière : revert de la PR ; les champs additionnels sont optionnels.
Claude seul relit, fusionne, active et fait la recette S24.
