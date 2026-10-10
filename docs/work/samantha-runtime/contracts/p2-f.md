# P2-f — accès PC par le propriétaire existant

Contrat : document 15 de Claude, 10 octobre 2026. `authorized_keys` reste l'unique vérité d'autorisation ; seul `device/laptop_access.py` effectue les écritures. `computers.json` est une métadonnée dérivée dans le dossier existant, jamais une seconde autorité. `lastSeenAt` reste null. Le contrôleur étend son `state.json` existant pour l'appairage temporaire et ses reçus ; aucun registre, daemon ou scheduler supplémentaire.

## Routes natives owner

- GET `/v1/laptop-access/computers` : liste `{id,label,addedAt,lastSeenAt,ownerKey,payloadHash}`. Le hash permet l'intention de révocation exacte, sans renvoyer la ligne.
- POST `/v1/laptop-access/pairings` `{operationId}` : Tailscale obligatoire ; retour `{success,state,receipt,pairingId,code,expiresAt,command}`. Le code n'est renvoyé qu'à la création, jamais stocké, jamais journalisé. Un rejeu retrouve le même pairing et son reçu sans recréer d'écouteur ni restituer le code. Si la première réponse est perdue, attendre l'expiration et préparer une nouvelle intention.
- GET `/v1/laptop-access/pairings/{id}` : état, dates et, après dépôt, libellé/empreinte/payloadHash. Aucune clé brute.
- POST `/v1/laptop-access/pairings/{id}/commit` `{operationId,confirmationId}` : consommation signée de `laptop_access.authorize_key`, référence pairingId, hash de la ligne complète qui sera ajoutée.
- DELETE `/v1/laptop-access/computers/{id}` `{operationId,confirmationId}` : consommation de `laptop_access.revoke_key`, référence empreinte, hash de la ligne exacte hors terminaison de ligne.

Les mutations exigent loopback, absence d'origine navigateur et `x-clawmobile-owner-flow: v1`. L'app prépare la confirmation via `/v1/confirmations`, puis l'activité biométrique existante. TTL 120 secondes, preuve et consommation à usage unique inchangées. Le contrôleur vérifie en plus le reçu consommé dans le registre Companion existant et sa correspondance d'action/référence/hash. Pas de `consume` public, de booléen client d'autorisation ou de callback arbitraire. Le hash d'autorisation concerne la ligne finale contenant le commentaire géré, pas l'ancien commentaire éventuel du PC.

## Transport et mutation

Enfant éphémère du contrôleur, socket déjà lié uniquement à l'IP Tailscale 100.64/10, port 8023. Arrêt à 10 minutes, au premier dépôt valide ou après cinq refus. Code base32 de huit caractères sans I/O, seul SHA256 persisté. Un POST fermé `{code,publicKey,label}` ; clé ed25519 structurellement valide, 1 Ko maximum, sans options ; libellé ASCII fermé de 40 caractères. Aucun ajout avant biométrie. Commande PowerShell pour la clé existante/créée et le dépôt puis la commande SSH canonique.

Ajout atomique 0600, idempotence par empreinte, commentaire `samantha-pc:<empreinte8>:<label>`. Révocation d'une seule ligne identifiée, conservation des autres octets, refus de dernière clé, ordinateur inconnu et lignes dupliquées ambiguës. Une clé owner révoquée perd sa copie publique de restauration ; les autres clés restent utilisables et connect ne réautorise pas implicitement l'ancien owner. Les reçus sont persistés avant effet ; une issue indéterminée reste indéterminée et ne rejoue pas l'écriture.

## Preuves et limites

Tests sur dossiers et clés synthétiques, contrôle des signatures P-256 et isolation inter-domaines, états expirés/essais/réutilisation, atomicité/modes/révocation/rejeux et régression connect/disconnect/status/diagnostic. Aucun appairage réel, aucune biométrie humaine ou activation sur S24 revendiqués. Écrans et recette physique à Claude. Paiement inchangé.

Le contrôleur revérifie la signature de la confirmation consommée avec OpenSSL, contre la clé publique owner existante, le binding complet et la durée de 120 s. Une preuve altérée ou une clé publique indisponible refuse l’autorisation. Cette dépendance fait partie de la recette de release par Claude. Les lectures liste/status ne créent pas de fichier ; l’expiration est une projection calculée.
