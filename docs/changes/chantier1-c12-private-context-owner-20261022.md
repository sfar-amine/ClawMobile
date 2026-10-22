# C12 — le contexte partagé reste derrière l'admission MCP propriétaire

Le lecteur C9 était fermé sans preuve typée de son propriétaire. C12 transporte l'admission serveur `chat-owner` par la WeakMap et le canal privé déjà existants, avec contrôle de requête, client, fil et fraîcheur avant la première lecture. Un profil propriétaire dans un JSON, un appelant déclaré ou un checksum ne donnent aucun droit. Les reçus v2 gardent les références et empreintes de sources, sans corps de mémoire.

Sondes locales : admission Node 21/21 ; helper Python 17/17 ; reçu propriétaire 23/23 ; entrée MCP 29/29 ; ports privés lecture 18/18 et entrée 10/10 ; consommateurs 14/14, relais/reconnexion et authentification Worker verts. La paire portable importe les vrais propriétaires C9 au SHA immuable et conserve un résultat explicitement MOCK : deux lectures de fixture, zéro lecture privée pour les entrées non admises ou shadow, zéro fournisseur/effet réel. Contrat et commande : [C12](../work/samantha-runtime/contracts/c12-mcp-private-context-owner.md).

Aucune activation, recette téléphone ou CI complète n'est revendiquée. La voix en direct et le parcours de paiement ne sont pas modifiés. Retour arrière : revert, sans migration des reçus.
