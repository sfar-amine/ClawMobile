# F3 — Codes et durées dans le reçu vocal existant

Le checkpoint vocal accepte un résumé C1 facultatif, fermé et borné. Le registre de runs existant le conserve et le reprojette ; `claw-trace --turn` le lit sans ADB quand il est présent. Les familles de panne reprennent F2, sans texte réseau libre. Révisions et terminalité inchangées, aucun tour inventé.

Provenance : horodatages S24 du 18/10 déjà rejoués dans le test `claw-trace`, projetés dans une nouvelle enveloppe explicitement contractuelle. Aucun accès écran, geste, installation ou reçu physique dans cette tranche.

Reprise du 03/11 : merge de `runtime/samantha-companion-private` (9cfabb0e). Le seul conflit, dans la projection vocale de `runs.ts`, garde `turnMeasurement` (L4) et `voiceDiagnostics` côte à côte. `claw-trace` accepte désormais les mêmes identifiants que `VOICE_TURN_ID_RE`, y compris `voice-readback-<uuid>`, et un test CI vérifie que les deux copies restent identiques.

Validation : build du plugin vert, 7/7 cas CJS F3, 10/10 cas Python `claw-trace`, régressions vocales voisines (terminalité, accueil, mesure de tour, relecture différée, recette vocale) vertes. La CI canonique exacte reste à exécuter.

**Ordre de livraison** : ce runtime doit être déployé avant toute installation de l'app F3 (#375). Le runtime actuel refuse la clé `diagnostics` (400 `invalid_voice_transcript`).

Impact capability/architecture : aucun nouveau point d'entrée ni propriétaire. Les six primitives MCP gardent leurs schémas et adaptateurs ; `claw_exec` peut lire les mêmes reçus par le script existant. Aucun secret et aucun changement du parcours de paiement. Retour arrière par revert, sans migration.
