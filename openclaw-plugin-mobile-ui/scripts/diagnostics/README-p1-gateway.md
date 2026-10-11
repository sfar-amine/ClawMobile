# Diagnostic P1 du Gateway public isolé

Ce diagnostic manuel complète la matrice `scripts/test-owner-turn-admission.cjs`, déjà exécutée par la CI Node 20. Le Gateway public OpenClaw 2026.9.6 exige Node 24 ou plus ; ce diagnostic utilise explicitement Node 26. Il ne constitue ni une capture S24 ni une recette Android/biométrie. Aucun résultat de ce diagnostic n'est ajouté au décompte des étapes CI.

Après `npm run build`, exécuter avec le paquet public installé, le binaire public Node 26 et un dossier de sortie **nouveau** :

```sh
node scripts/diagnostics/p1-gateway-isolated.cjs /path/to/openclaw /path/to/node26 /path/to/new-output
```

Le diagnostic crée un profil, une configuration, un état, un port loopback et un jeton aléatoire jetables. L'environnement enfant est une liste explicite et n'hérite d'aucun jeton S24. Le fournisseur de modèle est HTTP local et déterministe, sans compte externe. Les appels de métadonnées du SDK ne sont pas une garantie d'isolation réseau complète ; aucun compte externe n'est configuré. Les fichiers jetables et le jeton sont détruits en fin de diagnostic ; seules les preuves nettoyées sont conservées.

Six vérifications : propriétaire contre tiers ; révocation après réception qui conserve le tour accepté ; tour suivant non propriétaire ; annulation par le propriétaire Gateway existant avec zéro effet ultérieur ; clarification HTTP signée ; et **révocation dans le callback HELLO du vrai GatewayClient public, avant `agent`, sans invocation d'outil**.

La dernière vérification utilise uniquement une interposition de test sur le callback du client public. Le transport, le handshake, l'authentification et les scopes restent ceux du vrai SDK installé. Aucun WebSocket ni propriétaire de transport n'est réimplémenté.

La garantie production est une vérification du ticket immédiatement avant l'envoi synchronique du paquet `agent`. Après envoi, une erreur est indéterminée et ne provoque ni second envoi ni repli CLI. Après acceptation, un effet reste possible malgré révocation ; le reçu existant est conservé. L'annulation app n'est pas livrée par ce correctif.
