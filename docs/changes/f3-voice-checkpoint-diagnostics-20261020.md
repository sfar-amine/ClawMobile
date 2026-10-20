# F3 — Codes et durées dans le reçu vocal existant

Le checkpoint vocal accepte un résumé C1 facultatif, fermé et borné. Le registre de runs existant le conserve et le reprojette ; `claw-trace --turn` le lit sans ADB quand il est présent. Les familles de panne reprennent F2, sans texte réseau libre. Révisions et terminalité inchangées, aucun tour inventé.

Provenance : horodatages S24 du 18/10 déjà rejoués dans le test `claw-trace`, projetés dans une nouvelle enveloppe explicitement contractuelle. Aucun accès écran, geste, installation ou reçu physique dans cette tranche.

Validation disponible : 9/9 cas Python verts, dont confidentialité, rejet fermé et absence d'appel ADB ; compilation TypeScript réussie au commit `fa2ad419`. Le premier ciblé CJS a échoué parce que le scénario de corruption réutilisait le cache légitime du propriétaire. Le test corrigé impose une vraie relecture dans un nouveau processus et attend son rejeu. Les régressions suivantes et la CI canonique exacte restent à exécuter ; la PR reste en brouillon.

Impact capability/architecture : aucun nouveau point d'entrée ni propriétaire. Les six primitives MCP gardent leurs schémas et adaptateurs ; `claw_exec` peut lire les mêmes reçus par le script existant. Aucun secret et aucun changement du parcours de paiement. Retour arrière par revert, sans migration.
