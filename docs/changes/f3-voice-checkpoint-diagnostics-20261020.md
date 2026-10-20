# F3 — Codes et durées dans le reçu vocal existant

Le checkpoint vocal accepte un résumé C1 facultatif, fermé et borné. Le registre de runs existant le conserve et le reprojette ; `claw-trace --turn` le lit sans ADB quand il est présent. Les familles de panne reprennent F2, sans texte réseau libre. Révisions et terminalité inchangées, aucun tour inventé.

Provenance : horodatages S24 du 18/10 déjà rejoués dans le test `claw-trace`, projetés dans une nouvelle enveloppe explicitement contractuelle. Aucun accès écran, geste, installation ou reçu physique dans cette tranche.

Validation disponible : 9/9 cas Python verts, dont confidentialité, rejet fermé et absence d'appel ADB. Compilation et test CJS ciblé, puis CI locale canonique exacte, restent à exécuter dans le créneau partagé ; la PR reste en brouillon.

Impact capability/architecture : aucun nouveau point d'entrée ni propriétaire. Les six primitives MCP gardent leurs schémas et adaptateurs ; `claw_exec` peut lire les mêmes reçus par le script existant. Aucun secret et aucun changement du parcours de paiement. Retour arrière par revert, sans migration.
